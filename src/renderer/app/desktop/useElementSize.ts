import { useCallback, useState, type RefCallback } from 'react';
import type { Size } from './window-model';

/**
 * The client size of an element, kept current with a ResizeObserver. Null
 * until it has been measured, and where measuring is impossible (no
 * ResizeObserver, or a zero size, as in jsdom).
 */
export function useElementSize<T extends HTMLElement>(): [RefCallback<T>, Size | null] {
  const [size, setSize] = useState<Size | null>(null);
  const ref = useCallback<RefCallback<T>>((element) => {
    if (!element || typeof ResizeObserver === 'undefined') {
      return undefined;
    }
    const measure = () => {
      const width = element.clientWidth;
      const height = element.clientHeight;
      setSize((previous) => {
        if (width <= 0 || height <= 0) {
          return null;
        }
        return previous?.width === width && previous.height === height
          ? previous
          : { width, height };
      });
    };
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    measure();
    return () => {
      observer.disconnect();
    };
  }, []);
  return [ref, size];
}
