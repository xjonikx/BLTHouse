// Public Pages config — no secrets here (never put service_role).
window.BLT_HOUSE_EXT = {
  broadcasterId: "475802457",

  // ── STATE Supabase (game queue + house panel DTO) ─────────────────────────
  // Tables: blt_house_actions, blt_house_state (see github-pages/supabase/README.md)
  supabaseUrl: "https://lqtamumrzdlspcxfldjj.supabase.co",
  supabaseAnonKey: "sb_publishable_IqzgEZTYV3d8oLP3ii2dZw_ygwWLgB0",
  // aliases (same project)
  stateSupabaseUrl: "https://lqtamumrzdlspcxfldjj.supabase.co",
  stateSupabaseAnonKey: "sb_publishable_IqzgEZTYV3d8oLP3ii2dZw_ygwWLgB0",

  // ── ATMOSPHERE Supabase (Presence WS + SQL layout/actors — separate project) ─
  // Run github-pages/supabase/atmosphere.sql once on this project.
  atmosphereSupabaseUrl: "https://gwtpamejjyewtudetxru.supabase.co",
  atmosphereSupabaseAnonKey: "sb_publishable_HB4Wyk6Xq4Vai0BduqTScg_XR064Rwd",

  // Optional local Bannerlord HTTP panel (dev only)
  localGameApi: "",

  // Twitch Application (OAuth Implicit) — Redirect: https://xjonikx.github.io/BLTHouse/
  twitchClientId: "jikzu97y2o467loo3th2ggw4ihi8xe",
  twitchRedirectUri: "https://xjonikx.github.io/BLTHouse",
};
