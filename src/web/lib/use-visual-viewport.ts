import { useLayoutEffect, useState } from 'react';
import type { CSSProperties } from 'react';

interface ViewportGeometry {
  height: number;
  top: number;
  constrained: boolean;
}

/** Keeps a narrow conversation inside the visible area above a software keyboard. */
export function useVisualViewport(enabled: boolean): { style: CSSProperties | undefined; compact: boolean } {
  const [geometry, setGeometry] = useState<ViewportGeometry | null>(null);
  useLayoutEffect(() => {
    const viewport = window.visualViewport;
    if (!enabled || !viewport) {
      setGeometry(null);
      return;
    }
    let frame: number | undefined;
    const update = () => {
      frame = undefined;
      // Let native pinch zoom pan normally; only compensate an unzoomed viewport.
      const next = window.innerWidth <= 850 && Math.abs(viewport.scale - 1) < .01 ? {
        height: viewport.height,
        top: viewport.offsetTop,
        constrained: viewport.height < window.innerHeight - 1 || viewport.offsetTop > 1,
      } : null;
      setGeometry(previous => previous?.height === next?.height && previous?.top === next?.top && previous?.constrained === next?.constrained ? previous : next);
    };
    const schedule = () => {
      if (frame === undefined) frame = requestAnimationFrame(update);
    };
    update();
    viewport.addEventListener('resize', schedule);
    viewport.addEventListener('scroll', schedule);
    window.addEventListener('resize', schedule);
    return () => {
      if (frame !== undefined) cancelAnimationFrame(frame);
      viewport.removeEventListener('resize', schedule);
      viewport.removeEventListener('scroll', schedule);
      window.removeEventListener('resize', schedule);
    };
  }, [enabled]);
  return {
    style: geometry?.constrained ? { position: 'fixed', top: geometry.top, left: 0, right: 0, height: geometry.height } : undefined,
    compact: geometry !== null && geometry.height < 600,
  };
}
