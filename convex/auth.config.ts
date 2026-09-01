// Convex Auth: the deployment issues its own tokens and is its own issuer.
export default {
  providers: [
    {
      domain: process.env.CONVEX_SITE_URL,
      applicationID: "convex",
    },
  ],
};
