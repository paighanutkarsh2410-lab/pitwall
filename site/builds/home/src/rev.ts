/** A race winner's real telemetry around lights out (races.json, from OpenF1). */
export interface RevSample {
  t: number; // ms from lights out
  speed: number; // km/h
  throttle: number; // %
  gear: number;
  rpm: number;
}

export class Telemetry {
  private constructor(private readonly samples: RevSample[]) {}

  /** From rows of [ms from lights out, speed, throttle, gear, rpm] (races.json's `rev`). */
  static from(rows: number[][]): Telemetry | null {
    if (rows.length < 8) return null;
    return new Telemetry(rows.map(([t, speed, throttle, gear, rpm]) => ({ t, speed, throttle, gear, rpm })));
  }

  get first(): number {
    return this.samples[0].t;
  }

  get last(): number {
    return this.samples[this.samples.length - 1].t;
  }

  /** The car at time t, interpolated between the samples around it. */
  at(t: number): RevSample {
    const s = this.samples;
    if (t <= s[0].t) return s[0];
    for (let i = 1; i < s.length; i++) {
      if (t <= s[i].t) {
        const a = s[i - 1];
        const b = s[i];
        const f = (t - a.t) / (b.t - a.t || 1);
        return {
          t,
          speed: a.speed + (b.speed - a.speed) * f,
          throttle: a.throttle + (b.throttle - a.throttle) * f,
          gear: f < 0.5 ? a.gear : b.gear,
          rpm: a.rpm + (b.rpm - a.rpm) * f,
        };
      }
    }
    return s[s.length - 1];
  }
}
