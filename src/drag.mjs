// dragTo: put the i-th div-based drag slider (window.__auditDragSliders()) at frac (0..1) with a
// real mouse press. These sliders read clientX from pointer events, so setting a value is not possible.
export async function dragTo(page, i, frac) {
  const box = await page.evaluate((i) => {
    const el = window.__auditDragSliders()[i];
    if (!el) return null;
    el.scrollIntoView({ block: 'center' });
    const r = el.getBoundingClientRect();
    return { x: r.left, y: r.top, w: r.width, h: r.height };
  }, i);
  if (!box) return false;
  await page.mouse.move(box.x + box.w * frac, box.y + box.h / 2);
  await page.mouse.down();
  await page.mouse.up();
  return true;
}
