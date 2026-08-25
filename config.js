// Public Pages config — no secrets here (never put service_role).
window.BLT_HOUSE_EXT = {
  broadcasterId: "475802457",

  // Preferred: Supabase queue + panel state (see github-pages/supabase/README.md)
  supabaseUrl: "https://lqtamumrzdlspcxfldjj.supabase.co",
  supabaseAnonKey: "sb_publishable_IqzgEZTYV3d8oLP3ii2dZw_ygwWLgB0",

  // Optional fallback for presence/layout or if Supabase not set yet
  ebsUrl: "https://bannerlord.mountandblade.workers.dev",
  localGameApi: "",
  preferQueue: true,

  // Twitch Application (OAuth Implicit) — Redirect: https://xjonikx.github.io/BLTHouse/
  // Same value → Cloudflare Worker Variable TWITCH_CLIENT_ID (only if using Worker auth)
  twitchClientId: "jikzu97y2o467loo3th2ggw4ihi8xe",
  twitchRedirectUri: "https://xjonikx.github.io/BLTHouse",
};
