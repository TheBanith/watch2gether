// Text chat + Telegram-style picker (emoji, stickers, GIFs).
// Messages are rendered with textContent (never innerHTML). Media messages
// are `kind:id` strings validated server-side and rendered from a local
// whitelist catalog — an unknown id falls back to plain text, so message
// bodies can never inject markup.
(() => {
  const AVATAR_COLORS = [
    '#5865f2', '#23a55a', '#f0b232', '#eb459e',
    '#9b59b6', '#00a8cc', '#e67e22', '#1abc9c',
  ];
  const GROUP_WINDOW_MS = 5 * 60 * 1000;
  const TYPING_TTL_MS = 3000;

  let lastSender = null;
  let lastTime = 0;
  let lastTypingEmit = 0;
  const typers = new Map(); // name -> timeout id
  let socket = null;

  // ---------------------------------------------------------------- catalogs
  const svgUrl = (svg) => 'data:image/svg+xml,' + encodeURIComponent(svg);
  const svgCache = new Map();
  const urlFor = (svg) => {
    let u = svgCache.get(svg);
    if (!u) { u = svgUrl(svg); svgCache.set(svg, u); }
    return u;
  };

  const STICKERS = {
    popcorn:
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128"><defs><linearGradient id="a" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ef4444"/><stop offset="1" stop-color="#b91c1c"/></linearGradient></defs><path d="M34 58h60l-7 56a8 8 0 0 1-8 7H49a8 8 0 0 1-8-7z" fill="url(#a)"/><path d="M53 58l-4 63h9l4-63zM76 58l4 63h9l-4-63z" fill="#fff" opacity=".92"/><g fill="#fde68a" stroke="#f59e0b" stroke-width="2"><circle cx="44" cy="46" r="13"><animate attributeName="cy" values="46;41;46" dur="1.6s" repeatCount="indefinite"/></circle><circle cx="66" cy="34" r="15"><animate attributeName="cy" values="34;28;34" dur="1.2s" repeatCount="indefinite"/></circle><circle cx="88" cy="45" r="13"><animate attributeName="cy" values="45;40;45" dur="1.9s" repeatCount="indefinite"/></circle><circle cx="56" cy="26" r="11"/><circle cx="78" cy="23" r="10"/></g></svg>`,
    clapper:
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128"><rect x="18" y="54" width="92" height="54" rx="8" fill="#1f2430"/><g><animateTransform attributeName="transform" type="rotate" values="0 22 54;-32 22 54;0 22 54" dur="1.7s" repeatCount="indefinite"/><rect x="18" y="38" width="92" height="18" rx="5" fill="#0b0d14"/><path d="M24 38h13l9 18H33zM52 38h13l9 18H61zM80 38h13l9 18H89z" fill="#f4f5f9"/></g><text x="64" y="90" font-family="Segoe UI,Arial,sans-serif" font-size="17" font-weight="800" fill="#f4f5f9" text-anchor="middle">ACTION!</text></svg>`,
    lol:
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128"><g><animateTransform attributeName="transform" type="rotate" values="-7 64 64;7 64 64;-7 64 64" dur="0.9s" repeatCount="indefinite"/><text x="64" y="82" font-family="Segoe UI,Arial,sans-serif" font-size="52" font-weight="900" fill="#facc15" stroke="#11131c" stroke-width="4" paint-order="stroke" text-anchor="middle">LOL</text></g><g fill="#38bdf8"><path d="M20 30l3 7 7 3-7 3-3 7-3-7-7-3 7-3z"><animate attributeName="opacity" values="0;1;0" dur="1.4s" repeatCount="indefinite"/></path><path d="M106 26l2.5 6 6 2.5-6 2.5-2.5 6-2.5-6-6-2.5 6-2.5z"><animate attributeName="opacity" values="0;1;0" dur="1.7s" begin="0.5s" repeatCount="indefinite"/></path></g></svg>`,
    love:
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128"><g transform="translate(64 64)"><g><animateTransform attributeName="transform" type="scale" values="1;1.12;1;1.05;1" dur="1s" repeatCount="indefinite"/><path transform="translate(-64 -64)" d="M64 110C28 86 14 66 14 46c0-16 12-26 26-26 10 0 18 5 24 14 6-9 14-14 24-14 14 0 26 10 26 26 0 20-14 40-50 64z" fill="#f43f5e"/><path transform="translate(-64 -64)" d="M40 34c-6 0-12 4-14 10" fill="none" stroke="#fecdd3" stroke-width="5" stroke-linecap="round" opacity=".8"/></g></g></svg>`,
    wow:
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128"><circle cx="64" cy="64" r="50" fill="#facc15"/><path d="M40 44l3.2 6.8L50 54l-6.8 3.2L40 64l-3.2-6.8L30 54l6.8-3.2zM88 44l3.2 6.8L98 54l-6.8 3.2L88 64l-3.2-6.8L78 54l6.8-3.2z" fill="#11131c"><animate attributeName="opacity" values="1;0.25;1" dur="1.3s" repeatCount="indefinite"/></path><ellipse cx="64" cy="86" rx="13" ry="16" fill="#11131c"><animate attributeName="ry" values="16;11;16" dur="1.5s" repeatCount="indefinite"/></ellipse></svg>`,
    cry:
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128"><circle cx="64" cy="64" r="50" fill="#7dd3fc"/><path d="M40 52c4-5 10-5 14 0M74 52c4-5 10-5 14 0" fill="none" stroke="#0c4a6e" stroke-width="5" stroke-linecap="round"/><path d="M46 84c5 7 27 7 32 0" fill="none" stroke="#0c4a6e" stroke-width="5" stroke-linecap="round"/><path d="M44 66h9M75 66h9" stroke="#0c4a6e" stroke-width="4" stroke-linecap="round"/><g fill="#2563eb"><path d="M40 74c0 0-9 12-9 17a9 9 0 0 0 18 0c0-5-9-17-9-17z"><animate attributeName="opacity" values="0;1;0" dur="2s" repeatCount="indefinite"/><animateTransform attributeName="transform" type="translate" values="0 0;0 8;0 0" dur="2s" repeatCount="indefinite"/></path></g></svg>`,
    party:
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128"><path d="M30 112l24-64 40 40z" fill="#7b5cff"/><path d="M38 90l14-38 24 24z" fill="#5865f2"/><g><g fill="#f43f5e"><rect x="70" y="20" width="10" height="10" rx="2"><animateTransform attributeName="transform" type="rotate" values="0 75 25;360 75 25" dur="1.6s" repeatCount="indefinite"/><animate attributeName="y" values="20;8;20" dur="1.6s" repeatCount="indefinite"/></rect></g><g fill="#22c55e"><rect x="94" y="34" width="9" height="9" rx="2"><animateTransform attributeName="transform" type="rotate" values="0 98 38;-360 98 38" dur="2s" repeatCount="indefinite"/><animate attributeName="y" values="34;22;34" dur="2s" repeatCount="indefinite"/></rect></g><g fill="#facc15"><rect x="84" y="10" width="9" height="9" rx="2"><animateTransform attributeName="transform" type="rotate" values="0 88 14;360 88 14" dur="1.4s" repeatCount="indefinite"/><animate attributeName="y" values="10;0;10" dur="1.4s" repeatCount="indefinite"/></rect></g><circle cx="104" cy="16" r="5" fill="#38bdf8"><animate attributeName="cy" values="16;4;16" dur="1.8s" repeatCount="indefinite"/></circle></g></svg>`,
    yes:
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128"><circle cx="64" cy="64" r="50" fill="#22c55e"/><path d="M40 66l16 16 32-36" fill="none" stroke="#fff" stroke-width="11" stroke-linecap="round" stroke-linejoin="round" stroke-dasharray="80" stroke-dashoffset="0"><animate attributeName="stroke-dashoffset" values="80;0;0;80" dur="2.4s" repeatCount="indefinite"/></path></svg>`,
    no:
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128"><circle cx="64" cy="64" r="50" fill="#ef4444"/><path d="M44 44l40 40M84 44l-40 40" fill="none" stroke="#fff" stroke-width="11" stroke-linecap="round" stroke-dasharray="70" stroke-dashoffset="0"><animate attributeName="stroke-dashoffset" values="70;0;0;70" dur="2.4s" repeatCount="indefinite"/></path></svg>`,
    zzz:
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128"><path d="M84 20a44 44 0 1 0 24 76A50 50 0 0 1 84 20z" fill="#fde68a"/><g font-family="Segoe UI,Arial,sans-serif" font-weight="900" fill="#a5b4fc"><text x="86" y="42" font-size="22">Z<animate attributeName="opacity" values="0;1;0" dur="2.2s" repeatCount="indefinite"/></text><text x="102" y="26" font-size="16">Z<animate attributeName="opacity" values="0;1;0" dur="2.2s" begin="0.5s" repeatCount="indefinite"/></text></g></svg>`,
    reel:
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128"><g><animateTransform attributeName="transform" type="rotate" values="0 64 64;360 64 64" dur="6s" repeatCount="indefinite"/><circle cx="64" cy="64" r="48" fill="#1f2430" stroke="#5865f2" stroke-width="6"/><circle cx="64" cy="40" r="10" fill="#0b0d14"/><circle cx="64" cy="88" r="10" fill="#0b0d14"/><circle cx="40" cy="64" r="10" fill="#0b0d14"/><circle cx="88" cy="64" r="10" fill="#0b0d14"/><circle cx="64" cy="64" r="7" fill="#7b5cff"/></g></svg>`,
  };

  const GIFS = {
    heartbeat:
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 200"><rect width="320" height="200" fill="#160b16"/><circle cx="160" cy="96" r="90" fill="#f43f5e" opacity=".14"/><g transform="translate(160 96)"><g><animateTransform attributeName="transform" type="scale" values="1;1.18;1;1.09;1" dur="1s" repeatCount="indefinite"/><path transform="translate(-56 -50)" d="M56 96C24 74 12 56 12 38c0-14 10-23 23-23 9 0 16 4 21 12 5-8 12-12 21-12 13 0 23 9 23 23 0 18-12 36-44 58z" fill="#fb7185"/></g></g><g fill="#fda4af"><circle cx="70" cy="160" r="6"><animate attributeName="cy" values="160;40" dur="2.4s" repeatCount="indefinite"/><animate attributeName="opacity" values="1;0" dur="2.4s" repeatCount="indefinite"/></circle><circle cx="250" cy="160" r="5"><animate attributeName="cy" values="160;50" dur="2.8s" begin="0.9s" repeatCount="indefinite"/><animate attributeName="opacity" values="1;0" dur="2.8s" begin="0.9s" repeatCount="indefinite"/></circle></g><text x="160" y="182" font-family="Segoe UI,Arial,sans-serif" font-size="16" font-weight="700" fill="#fda4af" text-anchor="middle">sending love</text></svg>`,
    loading:
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 200"><rect width="320" height="200" fill="#0c1020"/><g transform="translate(160 84)"><circle r="34" fill="none" stroke="#1e293b" stroke-width="9"/><path d="M0 -34a34 34 0 0 1 34 34" fill="none" stroke="#5865f2" stroke-width="9" stroke-linecap="round"><animateTransform attributeName="transform" type="rotate" values="0;360" dur="0.9s" repeatCount="indefinite"/></path></g><text x="160" y="156" font-family="Segoe UI,Arial,sans-serif" font-size="17" font-weight="700" fill="#c7ccff" text-anchor="middle">loading the movie<tspan><animate attributeName="opacity" values="0;1;0" dur="1.4s" repeatCount="indefinite"/>.</tspan><tspan><animate attributeName="opacity" values="0;1;0" dur="1.4s" begin="0.45s" repeatCount="indefinite"/>.</tspan><tspan><animate attributeName="opacity" values="0;1;0" dur="1.4s" begin="0.9s" repeatCount="indefinite"/>.</tspan></text></svg>`,
    fire:
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 200"><rect width="320" height="200" fill="#1a0d05"/><g transform="translate(160 170)"><path d="M0 -6C-30 -34-44 -58-38 -86 -34 -106-18 -122 0 -134 18 -122 34 -106 38 -86 44 -58 30 -34 0 -6z" fill="#f97316"><animateTransform attributeName="transform" type="scale" values="1 1;1.07 0.94;0.95 1.06;1 1" dur="0.55s" repeatCount="indefinite"/></path><path d="M0 -10C-16 -28-24 -44-20 -62 -17 -76-8 -86 0 -94 8 -86 17 -76 20 -62 24 -44 16 -28 0 -10z" fill="#fde047"><animateTransform attributeName="transform" type="scale" values="1 1;0.93 1.08;1.06 0.95;1 1" dur="0.4s" repeatCount="indefinite"/></path></g><text x="160" y="192" font-family="Segoe UI,Arial,sans-serif" font-size="15" font-weight="800" fill="#fdba74" text-anchor="middle" letter-spacing="4">TOO HOT</text></svg>`,
    dancedance:
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 200"><rect width="320" height="200" fill="#101425"/><g transform="translate(160 116)"><g><animateTransform attributeName="transform" type="rotate" values="-8 0 40;8 0 40;-8 0 40" dur="0.7s" repeatCount="indefinite"/><path d="M-36 -18h72l-8 76a10 10 0 0 1-10 9H-18a10 10 0 0 1-10-9z" fill="#ef4444"/><path d="M-14 -18l-4 85h10l4-85zM14 -18l4 85h10l-4-85z" fill="#fff" opacity=".9"/><g fill="#fde68a" stroke="#f59e0b" stroke-width="2"><circle cx="-18" cy="-34" r="11"><animate attributeName="cy" values="-34;-46;-34" dur="0.7s" repeatCount="indefinite"/></circle><circle cx="4" cy="-44" r="12"><animate attributeName="cy" values="-44;-56;-44" dur="0.55s" repeatCount="indefinite"/></circle><circle cx="26" cy="-34" r="11"><animate attributeName="cy" values="-34;-44;-34" dur="0.8s" repeatCount="indefinite"/></circle></g></g></g><g font-family="Segoe UI,Arial,sans-serif" font-weight="900" fill="#38bdf8"><text x="46" y="60" font-size="30"><animateTransform attributeName="transform" type="translate" values="0 0;0 -10;0 0" dur="1.1s" repeatCount="indefinite"/>♪</text><text x="250" y="52" font-size="26" fill="#a78bfa"><animateTransform attributeName="transform" type="translate" values="0 0;0 -12;0 0" dur="1.4s" repeatCount="indefinite"/>♫</text></g></svg>`,
    lolroll:
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 200"><rect width="320" height="200" fill="#141024"/><g transform="translate(160 96)"><g><animateTransform attributeName="transform" type="rotate" values="-14 0 0;14 0 0;-14 0 0" dur="0.8s" repeatCount="indefinite"/><circle r="58" fill="#facc15"/><path d="M-34 -16c5-8 13-8 18 0M16 -16c5-8 13-8 18 0" fill="none" stroke="#11131c" stroke-width="5" stroke-linecap="round"/><path d="M-26 16c8 18 44 18 52 0z" fill="#11131c"/><path d="M-46 -4c-8 14-6 26 2 30 6 3 10-4 8-14-2-8-6-14-10-16z" fill="#38bdf8"><animate attributeName="opacity" values="1;0.2;1" dur="1s" repeatCount="indefinite"/></path><path d="M46 -4c8 14 6 26-2 30-6 3-10-4-8-14 2-8 6-14 10-16z" fill="#38bdf8"><animate attributeName="opacity" values="0.2;1;0.2" dur="1s" repeatCount="indefinite"/></path></g></g><text x="160" y="184" font-family="Segoe UI,Arial,sans-serif" font-size="17" font-weight="800" fill="#fde68a" text-anchor="middle">I CAN'T BREATHE</text></svg>`,
    brb:
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 200"><rect width="320" height="200" fill="#0d1220"/><g transform="translate(96 100)"><circle r="44" fill="#1e293b" stroke="#5865f2" stroke-width="5"/><path d="M0 -26V0l18 12" fill="none" stroke="#c7ccff" stroke-width="6" stroke-linecap="round"><animateTransform attributeName="transform" type="rotate" values="0;360" dur="4s" repeatCount="indefinite"/></path></g><text x="216" y="112" font-family="Segoe UI,Arial,sans-serif" font-size="58" font-weight="900" fill="#f4f5f9">BRB<tspan fill="#5865f2"><animate attributeName="opacity" values="1;0;1" dur="1.2s" repeatCount="indefinite"/>_</tspan></text></svg>`,
    confetti:
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 200"><rect width="320" height="200" fill="#0f1226"/><g><g fill="#f43f5e"><rect x="30" y="-14" width="10" height="14" rx="3"><animateTransform attributeName="transform" type="rotate" values="0 35 -7;540 35 -7" dur="3s" repeatCount="indefinite"/><animate attributeName="y" values="-14;210" dur="3s" repeatCount="indefinite"/></rect></g><g fill="#22c55e"><rect x="96" y="-14" width="9" height="13" rx="3"><animateTransform attributeName="transform" type="rotate" values="0 100 -7;-540 100 -7" dur="3.6s" begin="0.6s" repeatCount="indefinite"/><animate attributeName="y" values="-14;210" dur="3.6s" begin="0.6s" repeatCount="indefinite"/></rect></g><g fill="#facc15"><rect x="170" y="-14" width="10" height="14" rx="3"><animateTransform attributeName="transform" type="rotate" values="0 175 -7;540 175 -7" dur="3.2s" begin="1.2s" repeatCount="indefinite"/><animate attributeName="y" values="-14;210" dur="3.2s" begin="1.2s" repeatCount="indefinite"/></rect></g><g fill="#38bdf8"><rect x="240" y="-14" width="9" height="13" rx="3"><animateTransform attributeName="transform" type="rotate" values="0 244 -7;-540 244 -7" dur="2.8s" begin="0.3s" repeatCount="indefinite"/><animate attributeName="y" values="-14;210" dur="2.8s" begin="0.3s" repeatCount="indefinite"/></rect></g><circle cx="286" cy="20" r="7" fill="#a78bfa"><animate attributeName="cy" values="-10;210" dur="3.4s" begin="1.7s" repeatCount="indefinite"/></circle><circle cx="60" cy="40" r="6" fill="#fb7185"><animate attributeName="cy" values="-10;210" dur="4s" begin="2.2s" repeatCount="indefinite"/></circle></g><text x="160" y="118" font-family="Segoe UI,Arial,sans-serif" font-size="44" font-weight="900" fill="#f4f5f9" stroke="#5865f2" stroke-width="3" paint-order="stroke" text-anchor="middle">woohoo!</text></svg>`,
    theend:
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 200"><rect width="320" height="200" fill="#05060a"/><g fill="#1f2430"><rect y="0" width="320" height="26"/><rect y="174" width="320" height="26"/></g><g fill="#05060a"><rect x="14" y="6" width="18" height="14" rx="3"/><rect x="58" y="6" width="18" height="14" rx="3"/><rect x="102" y="6" width="18" height="14" rx="3"/><rect x="146" y="6" width="18" height="14" rx="3"/><rect x="190" y="6" width="18" height="14" rx="3"/><rect x="234" y="6" width="18" height="14" rx="3"/><rect x="278" y="6" width="18" height="14" rx="3"/><rect x="14" y="180" width="18" height="14" rx="3"/><rect x="58" y="180" width="18" height="14" rx="3"/><rect x="102" y="180" width="18" height="14" rx="3"/><rect x="146" y="180" width="18" height="14" rx="3"/><rect x="190" y="180" width="18" height="14" rx="3"/><rect x="234" y="180" width="18" height="14" rx="3"/><rect x="278" y="180" width="18" height="14" rx="3"/></g><text x="160" y="112" font-family="Georgia,serif" font-size="46" font-weight="700" fill="#e2e5ff" text-anchor="middle" letter-spacing="6"><animate attributeName="opacity" values="1;0.55;1" dur="3s" repeatCount="indefinite"/>THE END</text><path d="M160 130l4 9 9 4-9 4-4 9-4-9-9-4 9-4z" fill="#fde68a"><animate attributeName="opacity" values="0.3;1;0.3" dur="2.2s" repeatCount="indefinite"/></path></svg>`,
  };

  const MEDIA_RE = /^(sticker|gif):([a-z0-9-]{1,40})$/;
  function mediaFrom(body) {
    const m = MEDIA_RE.exec(String(body || ''));
    if (!m) return null;
    const cat = m[1] === 'sticker' ? STICKERS : GIFS;
    const svg = cat[m[2]];
    if (!svg) return null;
    return { kind: m[1], id: m[2], url: urlFor(svg) };
  }

  // ------------------------------------------------------------------ emoji
  const EMOJI = {
    smileys: '😀|😃|😄|😁|😆|😅|🤣|😂|🙂|🙃|😉|😊|😍|🥰|😘|😗|😋|😛|🤪|🤗|🤔|🤨|😐|😑|😶|😏|😒|🙄|😬|😮|😯|😲|🥱|😴|😌|😔|😪|😭|😤|😡|🥺|😳|🥵|🥶|😱|😨|😰|😷|🤒|🤕|🤯|🤠'.split('|'),
    people: '👋|🤙|👌|✌️|🤞|🤘|☝️|👇|👉|👈|✊|👊|🤛|🤜|🙌|👐|🤲|🤝|💪|🙏|👏|👍|👎|🫰|👀|🧠|💤'.split('|'),
    nature: '🐶|🐱|🦊|🐻|🐼|🐨|🐯|🦁|🐮|🐷|🐸|🐵|🙈|🙉|🙊|🐔|🐧|🐦|🐤|🦆|🦅|🦉|🦇|🐺|🐗|🐴|🦄|🐝|🦋|🐌|🐞|🐢|🐍|🐙|🦑|🦐|🦀|🐡|🐠|🐟|🐬|🐳|🦈|🌸|🌹|🌺|🌻|🌼|🌷|🌾|🍀|🍁|🍂|🌪|🌍|🌙|⭐|✨|⚡|🌈|☀️|⛅|☁️|❄️'.split('|'),
    food: '🍿|🥤|🍫|🍬|🍭|🍕|🍔|🍟|🌮|🍜|🍣|🍱|🍤|🍦|🍰|🎂|🧁|🍩|🍪|☕|🧃|🍺|🍷|🥂|🍎|🍌|🍇|🍓|🥕|🌽'.split('|'),
    activity: '🎬|🎥|🎭|🎤|🎧|🎵|🎶|🎸|🥁|🎺|🎻|🏆|⚽|🏀|🎮|🎲|🎯|🥊|🎿|🧗|🎣'.split('|'),
    travel: '🚗|✈️|🚀|🛸|🏝|🏕|⛰|🏔|🗼|🗽|🌉|🏙|🌃|🚢|🚁|🚲|🛵'.split('|'),
    objects: '💡|📱|💻|🖥|⌚|👓|🎒|💼|🔧|🔑|📷|🗓|🎁|🎈|🧩|📚|🕯|💸'.split('|'),
    symbols: '❤️|🧡|💛|💚|💙|💜|🖤|🤍|💔|❣️|💕|💯|✅|❌|❓|❗|⛔|♻️|🔴|🔵|🟠|🟢|🟣|💤|🌀|🆕|🔥|💥|🎉'.split('|'),
    flags: '🇬🇧|🇫🇷|🇩🇪|🇪🇸|🇮🇹|🇺🇸|🇯🇵|🇰🇷|🇧🇷|🇨🇦|🇦🇺|🇮🇳|🇲🇽|🇳🇱|🇸🇪|🇵🇱'.split('|'),
  };
  const EMOJI_CATS = [
    ['recent', '🕘'], ['smileys', '😊'], ['people', '👋'], ['nature', '🐶'],
    ['food', '🍿'], ['activity', '🎬'], ['travel', '✈️'], ['objects', '💡'],
    ['symbols', '❤️'], ['flags', '🏁'],
  ];
  // keyword search over the catalog
  const EMOJI_KEYS = {
    '😂': 'laugh lol funny tears joy', '🤣': 'rofl laugh lol funny', '😊': 'smile happy blush',
    '😍': 'love heart eyes crush', '🥰': 'love adore blush', '❤️': 'heart love red like',
    '🔥': 'fire hot lit flame', '🎉': 'party tada celebrate confetti', '🍿': 'popcorn movie snack cinema',
    '🎬': 'movie film clapper cinema action', '🎥': 'camera movie cinema video', '😭': 'cry sob tears sad laugh',
    '😢': 'cry sad tear', '😡': 'angry mad rage', '🥺': 'plead puppy eyes please', '😱': 'scream shock scared',
    '😴': 'sleep tired zzz', '🤤': 'drool hungry', '🤔': 'hmm think question', '👀': 'eyes look watch',
    '👍': 'yes ok thumbs up approve', '👎': 'no thumbs down dislike', '👏': 'clap bravo applause',
    '🙏': 'please thanks pray namaste', '💪': 'strong muscle flex', '🤝': 'handshake deal agreement',
    '👋': 'wave hello hi bye', '✌️': 'peace victory', '🎉': 'party celebrate', '💯': 'hundred perfect score',
    '⭐': 'star favorite', '✨': 'sparkles shine magic', '🌙': 'moon night', '☀️': 'sun summer',
    '🌈': 'rainbow pride', '❄️': 'snow winter cold', '⚡': 'zap lightning fast', '🐶': 'dog puppy pet',
    '🐱': 'cat kitten pet', '🦊': 'fox', '🐻': 'bear', '🦄': 'unicorn magic', '🍕': 'pizza food',
    '🍔': 'burger food', '🍟': 'fries food', '🌮': 'taco food', '🍜': 'ramen noodles food',
    '🍣': 'sushi food', '🍦': 'ice cream dessert', '🎂': 'cake birthday', '☕': 'coffee drink',
    '🍺': 'beer drink', '🍷': 'wine drink', '✅': 'yes check done ok', '❌': 'no cross wrong',
    '💯': 'perfect hundred', '🎁': 'gift present', '🎈': 'balloon party', '🏆': 'trophy winner',
    '🎮': 'game gaming controller', '🎵': 'music note song', '🎧': 'headphones music',
    '💡': 'idea light bulb', '📱': 'phone mobile', '💻': 'laptop computer', '🚀': 'rocket launch space',
    '✈️': 'plane flight travel', '🚗': 'car drive', '🌍': 'earth world globe', '🌈': 'rainbow',
    '🎉': 'party', '❤️': 'love', '😇': 'angel innocent', '🤪': 'zany wild crazy', '😎': 'cool sunglasses',
    '🥳': 'party celebrate', '🤩': 'star eyes amazed', '😬': 'grimace awkward', '🫡': 'salute respect',
  };
  const RECENT_KEY = 'w2g-recent-emoji';

  function loadRecent() {
    try {
      const v = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]');
      return Array.isArray(v) ? v.filter((e) => typeof e === 'string').slice(0, 32) : [];
    } catch { return []; }
  }
  function pushRecent(e) {
    let r = loadRecent().filter((x) => x !== e);
    r.unshift(e);
    r = r.slice(0, 32);
    try { localStorage.setItem(RECENT_KEY, JSON.stringify(r)); } catch { /* private mode */ }
  }
  function searchEmoji(q) {
    const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
    if (!terms.length) return [];
    const out = [];
    const seen = new Set();
    for (const [cat, list] of Object.entries(EMOJI)) {
      for (const e of list) {
        if (seen.has(e)) continue;
        const hay = `${e} ${cat} ${EMOJI_KEYS[e] || ''}`.toLowerCase();
        if (terms.every((t) => hay.includes(t))) { seen.add(e); out.push(e); }
      }
    }
    return out.slice(0, 120);
  }

  // ---------------------------------------------------------------- rendering
  function avatarColor(name) {
    let h = 0;
    const s = String(name || '?');
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
    return AVATAR_COLORS[h % AVATAR_COLORS.length];
  }

  function fmtTime(ts) {
    const d = new Date(ts);
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  function appendMessage({ sender, body, createdAt }) {
    const log = document.getElementById('chat-log');
    const grouped = sender === lastSender && createdAt - lastTime < GROUP_WINDOW_MS;
    lastSender = sender;
    lastTime = createdAt;
    const li = document.createElement('li');
    li.className = grouped ? 'msg grouped' : 'msg';
    if (!grouped) {
      const avatar = document.createElement('span');
      avatar.className = 'avatar';
      avatar.textContent = (sender[0] || '•').toUpperCase();
      avatar.style.background = avatarColor(sender);
      li.appendChild(avatar);
    }
    const wrap = document.createElement('div');
    wrap.className = 'msg-body';
    if (!grouped) {
      const head = document.createElement('div');
      head.className = 'msg-head';
      const who = document.createElement('strong');
      who.textContent = sender;
      const when = document.createElement('span');
      when.className = 'muted msg-time';
      when.textContent = fmtTime(createdAt);
      head.appendChild(who);
      head.appendChild(when);
      wrap.appendChild(head);
    }
    const media = mediaFrom(body);
    if (media) {
      const box = document.createElement('div');
      box.className = 'msg-media';
      const img = document.createElement('img');
      img.className = media.kind;
      img.alt = media.kind === 'sticker' ? 'Sticker' : 'GIF';
      img.loading = 'lazy';
      img.src = media.url; // data URI from the local catalog, never the body
      box.appendChild(img);
      wrap.appendChild(box);
    } else {
      const text = document.createElement('div');
      text.className = 'msg-text';
      text.textContent = body;
      wrap.appendChild(text);
    }
    li.appendChild(wrap);
    log.appendChild(li);
    log.scrollTop = log.scrollHeight;
  }

  function appendSystem(text) {
    const log = document.getElementById('chat-log');
    lastSender = null;
    const li = document.createElement('li');
    li.className = 'sys-msg';
    li.textContent = text;
    log.appendChild(li);
    log.scrollTop = log.scrollHeight;
  }

  function typingRow() {
    let row = document.getElementById('typing');
    if (!row) {
      row = document.createElement('div');
      row.id = 'typing';
      row.className = 'typing';
      row.hidden = true;
      const log = document.getElementById('chat-log');
      log.parentNode.insertBefore(row, log.nextSibling);
    }
    return row;
  }

  function showTyping(name) {
    const row = typingRow();
    if (typers.has(name)) clearTimeout(typers.get(name));
    typers.set(
      name,
      setTimeout(() => {
        typers.delete(name);
        renderTypers();
      }, TYPING_TTL_MS)
    );
    renderTypers();
  }

  function renderTypers() {
    const row = typingRow();
    const names = [...typers.keys()];
    if (names.length === 0) {
      row.hidden = true;
      return;
    }
    row.hidden = false;
    row.textContent =
      names.length === 1 ? `${names[0]} is typing…` : `${names.join(', ')} are typing…`;
  }

  // ------------------------------------------------------------------ picker
  let pickTab = 'emoji';
  let pickCat = 'smileys';
  let pickQuery = '';

  function pickEls() {
    return {
      panel: document.getElementById('pick-panel'),
      btn: document.getElementById('pick-btn'),
      grid: document.getElementById('pick-grid'),
      cats: document.getElementById('pick-cats'),
      search: document.getElementById('pick-search'),
      tabs: document.querySelectorAll('.pick-tab'),
      input: document.getElementById('chat-text'),
    };
  }

  function setPickerOpen(open) {
    const { panel, btn, search } = pickEls();
    if (!panel) return;
    panel.hidden = !open;
    btn.setAttribute('aria-expanded', String(open));
    if (open) renderPicker();
  }

  function makeItem(cls) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'pick-item ' + cls;
    return b;
  }

  function renderPicker() {
    const { grid, cats, search, tabs } = pickEls();
    for (const t of tabs) {
      const on = t.dataset.pick === pickTab;
      t.classList.toggle('is-on', on);
      t.setAttribute('aria-selected', String(on));
    }
    const showCats = pickTab === 'emoji' && !pickQuery;
    cats.hidden = !showCats;
    search.hidden = pickTab !== 'emoji';
    grid.className = 'pick-grid' + (pickTab === 'emoji' ? '' : ` mode-${pickTab}`);
    grid.innerHTML = '';

    if (pickTab === 'emoji') {
      for (const [key, icon] of EMOJI_CATS) {
        if (key === 'recent' && loadRecent().length === 0) continue;
        const c = document.createElement('button');
        c.type = 'button';
        c.className = 'pick-cat' + (key === pickCat && !pickQuery ? ' is-on' : '');
        c.textContent = icon;
        c.title = key;
        c.addEventListener('click', () => {
          pickCat = key;
          pickQuery = '';
          search.value = '';
          renderPicker();
        });
        cats.appendChild(c);
      }
      let list;
      if (pickQuery) list = searchEmoji(pickQuery);
      else if (pickCat === 'recent') list = loadRecent();
      else list = EMOJI[pickCat] || [];
      if (!list.length) {
        const empty = document.createElement('div');
        empty.className = 'pick-empty';
        empty.textContent = pickQuery ? 'No emoji found.' : 'Tap an emoji to build your recents.';
        grid.appendChild(empty);
        return;
      }
      for (const e of list) {
        const b = makeItem('pick-emoji');
        b.textContent = e;
        b.title = e;
        b.addEventListener('click', () => {
          insertAtCursor(pickEls().input, e);
          pushRecent(e);
          if (pickCat === 'recent' || pickQuery) renderPicker();
        });
        grid.appendChild(b);
      }
      return;
    }

    const cat = pickTab === 'sticker' ? STICKERS : GIFS;
    for (const id of Object.keys(cat)) {
      const b = makeItem(pickTab === 'sticker' ? 'pick-sticker' : 'pick-gif');
      const img = document.createElement('img');
      img.alt = id;
      img.src = urlFor(cat[id]);
      b.appendChild(img);
      b.addEventListener('click', () => {
        if (socket) socket.emit('chat:send', { kind: pickTab, id });
      });
      grid.appendChild(b);
    }
  }

  function insertAtCursor(input, str) {
    if (!input) return;
    const focused = document.activeElement === input;
    const s = focused ? input.selectionStart ?? input.value.length : input.value.length;
    const e = focused ? input.selectionEnd ?? s : s;
    input.value = input.value.slice(0, s) + str + input.value.slice(e);
    input.selectionStart = input.selectionEnd = s + str.length;
    input.focus();
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }

  function initPicker(roomSocket) {
    const { panel, btn, grid, search, tabs } = pickEls();
    if (!panel) return;

    btn.addEventListener('click', () => setPickerOpen(panel.hidden));
    for (const t of tabs) {
      t.addEventListener('click', () => {
        pickTab = t.dataset.pick;
        renderPicker();
      });
    }
    search.addEventListener('input', () => {
      pickQuery = search.value.trim();
      renderPicker();
    });
    search.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { setPickerOpen(false); btn.focus(); }
      if (e.key === 'Enter' && pickQuery) {
        // Enter in search inserts the first result rather than sending
        e.stopPropagation();
        const first = grid.querySelector('.pick-emoji');
        if (first) first.click();
      }
    });
    // Keep the composer focused when clicking the panel (caret preserved).
    panel.addEventListener('mousedown', (e) => {
      if (!(e.target instanceof HTMLInputElement)) e.preventDefault();
    });
    document.addEventListener('pointerdown', (e) => {
      if (panel.hidden) return;
      const t = e.target;
      if (panel.contains(t) || btn.contains(t)) return;
      setPickerOpen(false);
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !panel.hidden) setPickerOpen(false);
    });
  }

  // ------------------------------------------------------------------- init
  function init(roomCode, roomSocket) {
    socket = roomSocket;
    const input = document.getElementById('chat-text');

    const send = () => {
      const text = input.value.trim();
      if (!text) return;
      roomSocket.emit('chat:send', { body: text });
      input.value = '';
    };
    document.getElementById('chat-send').addEventListener('click', send);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') send();
    });
    input.addEventListener('input', () => {
      const now = Date.now();
      if (now - lastTypingEmit > 2500) {
        lastTypingEmit = now;
        roomSocket.emit('typing:start');
      }
    });

    initPicker(roomSocket);

    roomSocket.on('chat:history', (messages) => {
      document.getElementById('chat-log').innerHTML = '';
      lastSender = null;
      lastTime = 0;
      for (const m of messages) appendMessage(m);
    });
    roomSocket.on('chat:message', appendMessage);
    roomSocket.on('chat:error', ({ message } = {}) => {
      if (message) appendSystem(message);
    });
    roomSocket.on('typing', ({ name } = {}) => {
      if (name) showTyping(name);
    });
  }

  window.W2GChat = { init };
})();
