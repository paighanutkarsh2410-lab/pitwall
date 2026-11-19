# Brief: Pitwall, the race (site tab 1 of 3)

Self-authored under explicit creative delegation. The owner's words, verbatim:

> "design some crazy stuff for the frontend part"
>
> "see eventually I want a website hosted freely using netlify or something like that so even if
> it is scroll driven, you know like first animations and morphing like actual F1 TV and then if
> the user wants the things which we actually built, it swtiches to next tab, I dont care if there
> are multiple pages, do it"

Everything below that is not a quotation is an authored decision.

## The site

Three tabs, one site, hosted free (GitHub Pages; Netlify-ready):

1. **Race** (this build): a scroll-driven broadcast of one real race.
2. **Pit wall**: the actual pit-wall screen (web/), replaying the same race in the browser from
   a recording made by Pitwall's own timing, strategy and API code. Not a scroll page.
3. **Engineering**: how it is built (its own build, `../engineering`).

## The eight topics

1. **Vibe**: "actual F1 TV" (owner). Authored: a race broadcast's graphics package, at night, in
   the rain. References: a live sports broadcast's timing tower; a race-control message feed; the
   start-light gantry.
2. **The journey**: "first animations and morphing … then if the user wants the things which we
   actually built, it switches to next tab" (owner). Authored, per scroll: the lights go out, the
   grid morphs into the race, the rain, the safety cars, the red flag, the restart and the climb,
   the numbers, the flag, then the hand-off to the pit wall.
3. **Energy**: authored. Loud at the start, a pulse through the opening laps, dead calm at the red
   flag, loudest at the restart and the climb, a short hard stop at the flag.
4. **Feeling and the one moment**: authored, curve below. The moment: the climb.
5. **One thing no site does**: authored. Your scroll wheel is the race clock: one notch is a slice
   of a real race, and the timing tower re-sorts under your hand, lap by lap, from real data.
6. **How far from premium-minimal**: "crazy" (owner). Authored: dense and loud, broadcast-dense,
   inside the taste floor. Not the dark-with-one-accent default.
7. **One world or scenes**: authored: scenes, cut like a TV director cuts cameras, under one
   persistent graphics layer (tower, lap counter, track status). Not a continuous flight.
8. **Assets**: none supplied and no generation budget (no kie.ai key). Authored: the world is the
   race's own data, drawn: the real circuit outline from car positions, real grid, real order,
   real gaps, real weather and race-control text. Nothing photographic, nothing generated.

## Hard limits

- Unofficial: no F1, FIA, team or broadcaster logos, names styled as marks, or official fonts.
  Team colours appear only as the data's own per-car colour.
- Real numbers only. Every figure comes from `data/2024-sao-paulo/story.json`, written by
  `scripts/record_race.py` from the race's events through Pitwall's own models.
- One CTA label everywhere: **Open the pit wall**.

## Grammar: race broadcast (a new grammar)

None of the eight fit, because the page is two layers with different jobs. Authored as a new
grammar with its own nav, sequence, ending and bans:

- **Sequence**: director's cuts. Short, hard-cut shots (each 1.3 viewport-heights or less), each
  on its own painted ground, in race order. Cut length follows what happened, not a grid.
- **Nav**: a broadcast graphics package, persistent and loud: tabs, a live lap counter, track
  status, and the timing tower. The lap counter is information (where in the race you are), so
  it is not a section counter.
- **Ending**: the chequered flag, then an abrupt full-bleed hand-off to the pit wall.
- **Bans**: `pin` (holds happen in the graphics layer, never in a shot), `dwell`, `spotlight`,
  `magnet`, centred copy in consecutive shots, scroll cues, any drift interpolation between
  shots (each shot has its own ground).
- **Allows**: depth planes inside the hero shot only (a camera, not a page effect).

Why not the others: filmic one-shot hides its cuts, and a broadcast is made of cuts; rhythmic
cutlist bans the depth the hero needs and has no persistent data layer; live surface is the Pit
wall tab's job; continuous world, chaptered editorial, poster, gallery and split stage each lack
the persistent graphics layer that is the broadcast.

## The signature move

**The scroll wheel is the race clock.** Page scroll maps to race laps. A broadcast timing tower,
fixed in the graphics layer, re-sorts lap by lap from the real order (rows slide to their new
places), with the real gaps, while the lap counter and track status follow. At the peak the
tower unfurls to centre stage and holds while the shots underneath keep cutting.

## The feeling curve

| Shot | Feeling | What causes it |
|---|---|---|
| 1 Lights | Anticipation | Five lights fill one by one over the grid and the circuit, then go out |
| 2 Lap one | Exhilaration | The grid morphs into the real lap-one positions on the circuit |
| 3 Rain | Unease | Russell leads for 28 laps in the rain; the lap chart draws itself |
| 4 Safety car | Tension | A yellow ground, race control's own words arriving line by line |
| 5 Red flag | Stillness | A red ground, the clock stops, one line, nothing moves (authored silence) |
| 6–8 The climb | Awe (peak) | The restart; the tower unfurls and #1 climbs to the lead on lap 44 |
| 9 Numbers | Confidence | Real figures land: 35 stops, the fastest lap |
| 10 Flag | Release | The chequered flag and the podium |
| 11 Hand-off | Curiosity | "This was a recording. The pit wall runs it live." One button |

No two adjacent shots share a feeling.

## The peak

> "I scrolled and watched Verstappen go from seventeenth on the grid to the lead, and the timing
> tower moved under my hand."

It lives in shots 6–8 (laps 33 to 44), gets the most scroll (3.6 viewport-heights across three
cuts), and has the red flag's silence in front of it.

## Tell someone

> It's the site where your scroll wheel is the race clock, and you watch a driver climb from
> seventeenth to win.

## Authored silence

Shot 5 (red flag) is deliberately still: one line on a red ground, the clock frozen. It is not
dead scroll.

## Score

| Shot | Laps | Span (vh) | Device | Why |
|---|---|---|---|---|
| 1 Lights | grid | 1.0 | depth planes + bespoke lights from `--sc-p` | the open is a physical place: circuit far, grid mid, type near |
| 2 Lap one | 0–1 | 1.3 | bespoke morph from `--sc-p` | the grid becomes the race: a change of state you cause |
| 3 Rain | 2–27 | 1.2 | `reveal` (lap chart wipe) | a lead built over 28 laps reads as a line drawn left to right |
| 4 Safety car | 28–31 | 0.9 | `in` + staggered race-control lines | text arriving is what race control is |
| 5 Red flag | 32 | 1.0 | `kinetic` (once on the page) | one word, assembled, then nothing |
| 6 Restart | 33 | 1.2 | `in`, tower unfurls in chrome | the peak starts |
| 7 Ocon leads | 34–43 | 1.2 | `reveal` left | the second leader of the day |
| 8 Lap 44 | 44 | 1.2 | bespoke: the pass, highlighted in the tower | the peak lands |
| 9 Numbers | 45–68 | 1.1 | `count` | real figures land |
| 10 Flag | 69 | 1.0 | `reveal` iris (once) | the flag falls |
| 11 Hand-off | after | 0.9 | `in`, full bleed | abrupt, one action |

Total: about 12 viewport-heights across 11 shots, outside the 6-to-7 acts at 13.6 to 13.8 band.
Device families: depth planes, bespoke `--sc-p` morph, `reveal`, `in`, `kinetic`, `count`.
