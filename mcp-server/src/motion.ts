/**
 * Motion engine — pure math for bezier curves, easing, and path generation.
 * Zero dependencies on CDP, input drivers, or Node APIs.
 */

export interface Point {
  x: number;
  y: number;
}

export interface TimedPoint extends Point {
  /** Milliseconds from start of motion */
  t: number;
}

export interface MotionOptions {
  /** Total duration in milliseconds (default 500) */
  durationMs?: number;
  /** Number of intermediate points (default 20) */
  steps?: number;
  /** Easing function name (default 'easeInOutCubic') */
  easing?: EasingName;
  /** Max perpendicular jitter in pixels (default 0) */
  jitter?: number;
}

export type EasingName =
  | 'linear'
  | 'easeInQuad'
  | 'easeOutQuad'
  | 'easeInOutQuad'
  | 'easeInCubic'
  | 'easeOutCubic'
  | 'easeInOutCubic'
  | 'easeOutExpo';

/** Map normalized t∈[0,1] through an easing curve. */
export function ease(t: number, name: EasingName): number {
  switch (name) {
    case 'linear':
      return t;
    case 'easeInQuad':
      return t * t;
    case 'easeOutQuad':
      return t * (2 - t);
    case 'easeInOutQuad':
      return t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t;
    case 'easeInCubic':
      return t * t * t;
    case 'easeOutCubic': {
      const u = 1 - t;
      return 1 - u * u * u;
    }
    case 'easeInOutCubic':
      return t < 0.5
        ? 4 * t * t * t
        : 1 - Math.pow(-2 * t + 2, 3) / 2;
    case 'easeOutExpo':
      return t === 1 ? 1 : 1 - Math.pow(2, -10 * t);
  }
}

/** Evaluate a parametric cubic Bezier at parameter t∈[0,1]. */
export function cubicBezier(p0: Point, p1: Point, p2: Point, p3: Point, t: number): Point {
  const u = 1 - t;
  const u2 = u * u;
  const u3 = u2 * u;
  const t2 = t * t;
  const t3 = t2 * t;
  return {
    x: u3 * p0.x + 3 * u2 * t * p1.x + 3 * u * t2 * p2.x + t3 * p3.x,
    y: u3 * p0.y + 3 * u2 * t * p1.y + 3 * u * t2 * p2.y + t3 * p3.y,
  };
}

/**
 * Generate natural control points for a cubic Bezier between start and end.
 * Places control points at 1/3 and 2/3 along the line, offset perpendicular
 * for a gentle S-curve.
 */
export function autoControlPoints(
  start: Point,
  end: Point,
  curvature: number = 0.15,
): { cp1: Point; cp2: Point } {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  // Perpendicular direction
  const px = -dy;
  const py = dx;

  return {
    cp1: {
      x: start.x + dx / 3 + px * curvature,
      y: start.y + dy / 3 + py * curvature,
    },
    cp2: {
      x: start.x + (2 * dx) / 3 - px * curvature,
      y: start.y + (2 * dy) / 3 - py * curvature,
    },
  };
}

/**
 * Generate a bezier-eased path from start to end.
 * Returns TimedPoint[] with positions and wall-clock timing.
 *
 * Easing compresses parametric space at endpoints — the cursor accelerates
 * from rest, reaches max speed in the middle, and decelerates to rest.
 */
export function generatePath(start: Point, end: Point, options: MotionOptions = {}): TimedPoint[] {
  const {
    durationMs = 500,
    steps = 20,
    easing = 'easeInOutCubic',
    jitter = 0,
  } = options;

  const { cp1, cp2 } = autoControlPoints(start, end);
  const points: TimedPoint[] = [];

  // Perpendicular unit vector for jitter
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const len = Math.sqrt(dx * dx + dy * dy) || 1;
  const perpX = -dy / len;
  const perpY = dx / len;

  for (let i = 0; i <= steps; i++) {
    const linearT = i / steps;
    const easedT = ease(linearT, easing);
    const pos = cubicBezier(start, cp1, cp2, end, easedT);

    // Add perpendicular jitter (not at start/end)
    if (jitter > 0 && i > 0 && i < steps) {
      const j = (Math.random() * 2 - 1) * jitter;
      pos.x += perpX * j;
      pos.y += perpY * j;
    }

    points.push({ x: pos.x, y: pos.y, t: linearT * durationMs });
  }

  return points;
}

/**
 * Convert Catmull-Rom segment to cubic Bezier control points.
 * Given 4 sequential points, returns Bezier control points for the
 * segment between p1 and p2 with C1 continuity.
 */
function catmullRomToBezier(
  p0: Point, p1: Point, p2: Point, p3: Point,
  alpha: number = 0.5,
): { cp1: Point; cp2: Point } {
  return {
    cp1: {
      x: p1.x + (p2.x - p0.x) / (6 * alpha),
      y: p1.y + (p2.y - p0.y) / (6 * alpha),
    },
    cp2: {
      x: p2.x - (p3.x - p1.x) / (6 * alpha),
      y: p2.y - (p3.y - p1.y) / (6 * alpha),
    },
  };
}

/**
 * Generate a smooth spline path through multiple waypoints.
 * Uses Catmull-Rom→Bezier conversion for C1 continuity between segments.
 * For drawing: signatures, shapes, connecting diagram nodes.
 */
export function generateSplinePath(waypoints: Point[], options: MotionOptions = {}): TimedPoint[] {
  if (waypoints.length < 2) {
    throw new Error('generateSplinePath requires at least 2 waypoints');
  }

  if (waypoints.length === 2) {
    return generatePath(waypoints[0], waypoints[1], options);
  }

  const {
    durationMs = 500,
    steps = 20,
    easing = 'easeInOutCubic',
    jitter = 0,
  } = options;

  const n = waypoints.length;
  const stepsPerSegment = Math.max(3, Math.ceil(steps / (n - 1)));
  const totalSteps = stepsPerSegment * (n - 1);
  const points: TimedPoint[] = [];

  for (let seg = 0; seg < n - 1; seg++) {
    // Get 4 points for Catmull-Rom: p0, p1, p2, p3
    // Mirror endpoints for first/last segments
    const p0 = waypoints[Math.max(0, seg - 1)];
    const p1 = waypoints[seg];
    const p2 = waypoints[seg + 1];
    const p3 = waypoints[Math.min(n - 1, seg + 2)];

    const { cp1, cp2 } = catmullRomToBezier(p0, p1, p2, p3);

    const segSteps = seg < n - 2 ? stepsPerSegment : stepsPerSegment; // all segments equal
    const startStep = seg * stepsPerSegment;

    for (let i = 0; i <= segSteps; i++) {
      // Skip first point of non-first segments to avoid duplicates
      if (seg > 0 && i === 0) continue;

      const localT = i / segSteps;
      const globalStep = startStep + i;
      const globalT = globalStep / totalSteps;
      const easedT = ease(localT, 'linear'); // Ease globally, not per-segment
      const pos = cubicBezier(p1, cp1, cp2, p2, easedT);

      // Apply jitter
      if (jitter > 0 && globalStep > 0 && globalStep < totalSteps) {
        const dx = p2.x - p1.x;
        const dy = p2.y - p1.y;
        const len = Math.sqrt(dx * dx + dy * dy) || 1;
        const j = (Math.random() * 2 - 1) * jitter;
        pos.x += (-dy / len) * j;
        pos.y += (dx / len) * j;
      }

      // Apply global easing to the time distribution
      const wallT = ease(globalT, easing);
      points.push({ x: pos.x, y: pos.y, t: wallT * durationMs });
    }
  }

  return points;
}

/** Convert TimedPoints to an array of inter-step delays in milliseconds. */
export function computeDelays(points: TimedPoint[]): number[] {
  const delays: number[] = [];
  for (let i = 1; i < points.length; i++) {
    delays.push(Math.max(0, Math.round(points[i].t - points[i - 1].t)));
  }
  return delays;
}
