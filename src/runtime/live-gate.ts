let liveInFlight = 0;

export function beginLiveBridge() {
  liveInFlight += 1;
}

export function endLiveBridge() {
  liveInFlight = Math.max(0, liveInFlight - 1);
}

export function isLiveBridgeBusy() {
  return liveInFlight > 0;
}

export async function yieldToLiveBridge(gapMs = 0) {
  while (liveInFlight > 0) {
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  if (gapMs > 0) await new Promise((resolve) => setTimeout(resolve, gapMs));
  else await new Promise((resolve) => setImmediate(resolve));
}

export function resetLiveBridgeForTests() {
  liveInFlight = 0;
}
