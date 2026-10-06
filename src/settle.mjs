// settle: wait for the drawing to come to rest after a state change (click, slider, load).
//
// Two animation frames give a transition the chance to start. Web Animations with an end
// (CSS transitions, finite CSS animations) are awaited until they finish, up to maxMs, for up to
// three rounds in case one transition triggers the next. Infinite animations (spinners) are not
// awaited. Waiting a fixed delay instead measures mid-transition frames and reports overlaps
// that do not exist at rest.
export const settle = (page, ms = 90, maxMs = 2500) =>
  page.evaluate(
    async ([ms, maxMs]) => {
      const raf2 = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      await raf2();
      for (let round = 0; round < 3; round++) {
        const pending = document.getAnimations().filter((a) => {
          if (a.playState !== 'running') return false;
          const t = a.effect && a.effect.getComputedTiming ? a.effect.getComputedTiming() : null;
          return !!t && Number.isFinite(t.endTime);
        });
        if (!pending.length) break;
        await Promise.race([Promise.all(pending.map((a) => a.finished.catch(() => {}))), new Promise((r) => setTimeout(r, maxMs))]);
        await raf2();
      }
      await new Promise((r) => setTimeout(r, ms));
    },
    [ms, maxMs],
  );
