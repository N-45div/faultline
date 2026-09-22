import { v } from "convex/values";
import { vResultValidator, vWorkflowId, WorkflowManager, type WorkflowId } from "@convex-dev/workflow";
import { components, internal } from "./_generated/api";
import { internalMutation, type MutationCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { settle } from "../engine/call";
import { READING_PATIENCE_MS } from "./inbound";
import type { Ending } from "./calls";
import type { Reading } from "./agent";

// Everything after a phone call hangs up, as one durable workflow.
//
// The call is placed by convex/calls.ts. From then on:
//   1. it waits to be told to look. CALL-E's webhook says the call ended, and
//      the polls placed with the call say it may have; neither is believed.
//      Told, it reads the call back from CALL-E with our own key, and if it is
//      not over, waits to be told again;
//   2. what CALL-E heard is recorded alone, as a typed keyword is, when there is
//      no model to ask - or held while it is read a second time;
//   3. GPT-6 Astra reads the transcript without being told what CALL-E made of
//      it (convex/agent.ts);
//   4. what the two agree on is recorded, by the mutation a written answer's
//      path ends in, and the rest is asked again in writing (convex/inbound.ts).
// Each step is its own transaction or action, kept in the workflow's journal:
// reading CALL-E back and the second reading are tried again, backing off, when
// they fail, and a step that has finished is not run again. A second reading
// that fails every time leaves CALL-E's reading standing alone, as it always has.
//
// It is switched on by NOTICE_CALL_FLOW=workflow and by nothing else. Unset,
// or direct, calls finish as scheduled functions do, the way every call did
// before this, so a deploy moves no call onto it until the variable is set.
// The switch is read when a call is placed, never after, so a call finishes on
// the path it started on.
// The workflow's journal holds what was said; it is deleted when the workflow
// ends.

export const flow = new WorkflowManager(components.workflow);

/**
 * "workflow": calls placed now finish in the workflow below. Unset or "direct":
 * as they did before. Read as NOTICE_PAUSE is (convex/guard.ts), in any case, and
 * a value that is neither is said in the logs and switches nothing on.
 */
export function callFlow(): "workflow" | "direct" {
  const asked = (process.env.NOTICE_CALL_FLOW ?? "").trim().toLowerCase();
  if (asked === "workflow") return "workflow";
  if (asked !== "" && asked !== "direct") console.error(`[calls] NOTICE_CALL_FLOW: "${asked}" is not workflow or direct — calls finish the direct way`);
  return "direct";
}

/** What the webhook and the polls send: look at the call. It carries nothing to believe. */
const LOOK = "look";

/** CALL-E not answering: a few tries, a few seconds apart, before waiting for the next word to look. */
const READ_BACK = { maxAttempts: 4, initialBackoffMs: 2_000, base: 2 };
/** The model failing: tried again, then CALL-E's reading stands alone. */
const SECOND_READING = { maxAttempts: 3, initialBackoffMs: 5_000, base: 2 };

export const afterCall = flow.define({
  args: { callRow: v.id("calls"), callId: v.string() },
  handler: async (step, { callRow, callId }): Promise<void> => {
    let over: Ending | null = null;
    while (over === null) {
      await step.awaitEvent({ name: LOOK });
      try {
        const seen = await step.runAction(internal.calls.readBack, { callId }, { retry: READ_BACK });
        if (seen.kind === "settled") return;
        if (seen.kind === "over") over = seen.ending;
      } catch {
        // Not read, even after backing off: the next webhook or poll tries again.
      }
    }
    const next = await step.runMutation(internal.inbound.callOver, { callRow, ...over });
    if (next !== "read") return;
    let read: Reading | null;
    try {
      read = await step.runAction(internal.agent.secondReading, { callRow }, { retry: SECOND_READING });
    } catch {
      // As the direct path's reading does when its run fails.
      console.warn(`[calls] ${callId}: the second reading failed every time; CALL-E's reading stands alone`);
      const alone = settle(over.answers, null, over.turns);
      read = { answers: alone.agreed, unsure: [], declined: false, readBy: "CALL-E" };
    }
    if (read) await step.runMutation(internal.inbound.callRead, { callRow, ...read });
  },
});

/** Started in the mutation that parks the call as ringing (convex/calls.ts, placed). None if it cannot be: the call is already ringing, and finishes the direct way. */
export async function startAfterCall(ctx: MutationCtx, callRow: Id<"calls">, callId: string): Promise<WorkflowId | undefined> {
  try {
    return await flow.start(ctx, internal.callFlow.afterCall, { callRow, callId }, { onComplete: internal.callFlow.ended, context: { callRow, callId } });
  } catch (e) {
    console.error(`[calls] no workflow for ${callId}; it finishes the direct way: ${String(e)}`);
    return undefined;
  }
}

/**
 * A webhook or a poll says the call may be over (convex/calls.ts, reconcile):
 * its workflow is told to look. False when there is no workflow still running
 * to tell, and the caller finishes the call the direct way.
 */
export const nudge = internalMutation({
  args: { callRow: v.id("calls") },
  returns: v.boolean(),
  handler: async (ctx, { callRow }) => {
    const row = await ctx.db.get(callRow);
    if (!row?.workflowId) return false;
    if (row.finishedAt !== undefined) return true;
    if (!(await running(ctx, row.workflowId))) return false;
    await flow.sendEvent(ctx, { name: LOOK, workflowId: row.workflowId });
    return true;
  },
});

async function running(ctx: MutationCtx, workflowId: WorkflowId): Promise<boolean> {
  try {
    return (await flow.status(ctx, workflowId)).type === "inProgress";
  } catch {
    // Ended and deleted.
    return false;
  }
}

/**
 * The workflow has ended. Its journal is deleted. If the call is somehow not
 * finished - the workflow failed, or found a second reading from the direct
 * path under way - it is handed to the direct path: read back now, and again
 * once a second reading can no longer be waited for.
 */
export const ended = internalMutation({
  args: { workflowId: vWorkflowId, result: vResultValidator, context: v.object({ callRow: v.id("calls"), callId: v.string() }) },
  returns: v.null(),
  handler: async (ctx, { workflowId, result, context }) => {
    await ctx.scheduler.runAfter(0, internal.callFlow.forget, { workflowId });
    const row = await ctx.db.get(context.callRow);
    if (!row || row.finishedAt !== undefined) return null;
    console.warn(`[calls] ${context.callId}: its workflow ended ${result.kind}${result.kind === "failed" ? ` (${result.error})` : ""} with the call not finished; the direct way finishes it`);
    for (const after of [0, READING_PATIENCE_MS + 10_000]) await ctx.scheduler.runAfter(after, internal.calls.reconcile, { callId: context.callId });
    return null;
  },
});

export const forget = internalMutation({
  args: { workflowId: vWorkflowId },
  returns: v.null(),
  handler: async (ctx, { workflowId }) => {
    await flow.cleanup(ctx, workflowId);
    return null;
  },
});
