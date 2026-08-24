// GitHub Pages config — NO Twitch Extension secrets.
window.BLT_HOUSE_EXT = {
  // Same numeric channel id as in game (BLT log: Channel ID is …)
  broadcasterId: "475802457",

  // Cloudflare Worker queue URL
  ebsUrl: "https://bannerlord.mountandblade.workers.dev",

  // Optional: local game HTTP while developing
  localGameApi: "",

  // Prefer queue over local
  preferPubSub: true,
};
