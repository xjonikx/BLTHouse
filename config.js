// GitHub Pages — публичный config (без Extension Secret; секрет только в Cloudflare Worker + игра).
// Extension Client ID: dev.twitch.tv → Extensions → твоё расширение → вкладка Overview → Client ID (не OAuth secret!)
window.BLT_HOUSE_EXT = {
  extensionClientId: "al4k21cfc4ovg91loz7gfnogjregbv",

  // Пусто на Pages — PubSub идёт через Worker (секрет там)
  extensionSecret: "",

  // Numeric channel id (из лога BLT: Channel ID is 475802457)
  broadcasterId: "475802457",

  ebsUrl: "https://bannerlord.mountandblade.workers.dev/",

  localGameApi: "",
  preferPubSub: true,
};
