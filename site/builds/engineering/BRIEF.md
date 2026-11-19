# Brief: Pitwall, engineering (site tab 3 of 3)

Self-authored under explicit creative delegation (the owner's words are quoted in
`../race/BRIEF.md`: "then if the user wants the things which we actually built, it switches to
next tab … do it"). Everything below is an authored decision.

## The eight topics

1. **Vibe**: an engineering feature in a good technical magazine. Cool paper, exact line work,
   numbers set like evidence. References: a patent drawing; a racing team's technical briefing
   sheet; the appendix of a well-made engineering book.
2. **Journey**: what the system is, how one event crosses it, then four claims and the measured
   result behind each: releases that roll themselves back, a link you can cut, a race weekend at
   scale, the SLOs. It ends with how to run it yourself.
3. **Energy**: calm throughout, with one held chapter (the drawing). The race tab was loud; this
   one is the quiet after it.
4. **Feeling**: curve below. The moment: following one real event through the drawing.
5. **One thing no site does**: you ride one real lap event (Verstappen completing lap 44 at
   1:23.884) from the trackside replayer to a browser, and every stage it reaches is stamped
   with that stage's measured latency.
6. **Range**: editorial, dense with evidence. Not the race tab's broadcast.
7. **World or scenes**: chapters. Each lands on its own ground and stays there.
8. **Assets**: none. The world is a technical drawing of the real system and the project's own
   measurements (docs/progressive-delivery.md, docs/trackside.md, docs/scale-and-chaos.md,
   docs/observability.md, docs/slos.md).

## Grammar: chaptered editorial

The page is a feature to be read: chapters, a folio in the margin, a title page, a colophon.
Why not the others: filmic one-shot and race broadcast are the race tab's register; live
surface is the pit-wall tab; split stage has no two-sided argument here; gallery, poster and
cutlist suit products, slogans and energy, not evidence.

Bans honoured: no continuous drift (each chapter is a hard change of ground), no full-bleed scrub
hero, no pinned crossfade type, no magnetic CTA, no centred hero copy, no spotlight. The site's
tabs sit in a static strip at the top; the fixed chrome is the folio.

## The signature move

**Follow one event.** A pinned technical drawing of the pipeline draws itself, then one real
event travels its route under the reader's scroll: replayer, trackside Redpanda, uplink, the link,
factory Redpanda, ingest, timing, pitwall-api, the browser. As it reaches each stage, the drawing
stamps the measured number for that stage.

## The feeling curve

| Chapter | Feeling | What causes it |
|---|---|---|
| Title | Calm | A title page on paper: no media, one sentence |
| 1 The pipeline | Comprehension (peak) | The drawing builds; one real event crosses it with real latencies |
| 2 Releases | Trust | Three bad releases, each caught, with the minute and the second |
| 3 The link | Tension, then relief | A dark chapter: 70.3 s of outage, then 1.1 s to catch up, 0 lost |
| 4 Scale | Confidence | 200 browsers and four GameDays, as a results table |
| 5 SLOs | Assurance | The five promises and the drill that proved one pages |
| Colophon | Invitation | How to run it: one command, as a line of text |

## The peak

> "I followed one lap of Verstappen's through the whole system, and it told me how long each
> step took."

Chapter 1, the only pinned chapter, with the most scroll (2.4 viewport-heights). The title page
before it is the quiet.

## Tell someone

> It's the site where you follow one real racing lap through every part of the system that
> carried it.

## Score

| Chapter | Device | Why |
|---|---|---|
| Title | `in` | type arriving on paper is the whole title page |
| 1 Pipeline | `pin` + bespoke `--sc-p` drawing and travelling event | the held chapter, the peak |
| 2 Releases | `reveal` up at the chapter edge + `in` table | a change of subject |
| 3 Link | `count` on real figures | the numbers are the drama |
| 4 Scale | `parallax` in the media column + `in` | the one place depth helps |
| 5 SLOs | `in` | administrative: short, fast |
| Colophon | none | small type, running text |

About 9 viewport-heights across 7 sections. Families: `in`, `pin`, bespoke drawing, `reveal`,
`count`, `parallax`.
