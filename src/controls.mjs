// clickBtn: press a diagram button found again by label + occurrence (window.__auditButtons()),
// not by the index it had when the list was first built. Buttons that disappear when pressed
// would otherwise shift every later index. Returns false when the button is gone (that is not
// the same as a button that does nothing).
export const clickBtn = (page, c) =>
  page.evaluate(
    ([label, occ]) => {
      const b = window.__auditButtons().filter((x) => x.label === label)[occ];
      if (!b) return false;
      b.el.click();
      return true;
    },
    [c.label, c.occ],
  );
