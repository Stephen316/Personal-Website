// One window-level pointer, read inside animation frames by the background
// layers so the content on top never blocks them.
export const pointer = { x: 0, y: 0, active: false };

let started = false;

export function trackPointer() {
  if (started) return;
  started = true;
  const move = (e: PointerEvent) => {
    pointer.x = e.clientX;
    pointer.y = e.clientY;
    pointer.active = true;
  };
  addEventListener("pointermove", move, { passive: true });
  addEventListener("pointerdown", move, { passive: true });
  document.documentElement.addEventListener("mouseleave", () => (pointer.active = false));
}
