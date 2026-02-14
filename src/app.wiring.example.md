// In your app.js (already shared per your note), ensure you:
// - call `mountPositionDisc()` after dealing hole cards, and `updatePositionDisc()` each new hand
// - call `mountUnifiedBetPanel()` once on init
// - publish 'betting:context' with {pot, toCall, stage, textureHint}
// - listen for 'bet:preview:request' and reply with 'bet:preview:response'
//   using your existing computeRoundedBetAndPot(pot, pct) → {bet, newPot}
// - listen for 'betting:choose' and turn into actual game actions, then submit/advance
