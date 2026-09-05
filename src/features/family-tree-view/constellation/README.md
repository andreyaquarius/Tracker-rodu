# Сузір’я роду

Read-only, lazy-loaded view in **Родове дерево → Відображення дерева → Сузір’я роду**.

## Stage 1 — Рід

Bounded permission-scoped neighborhood (up to 1,000 people), deterministic Canvas layout in an isolated worker, pan/zoom, readable HTML labels, search, shortest relationship path, accessible person list and inherited tree palette. Worker failure has a bounded fallback. The graph itself has no idle animation loop; the separate optional moving sky was added in the presentation stage below.

## Stage 2 — Час

The **Рід / Час** switch adds a year slider, editable year, previous/next dated-year navigation, life-state marks, dated events, marriage/partnership milestones and recorded place observations. Person history preserves undated and approximate events. Clicking an event selects its person; history dates navigate the slider. Switching mode retains the selected year.

- `constellationDates.ts`: conservative year bounds for valid calendar dates, year ranges, before/after and approximate dates. It also retains calendar-order intervals at the recorded day/month/year precision for stage 3; missing days are not fabricated. No guessed ±N-year ranges. Display text takes precedence over a derived sort key.
- `constellationTime.ts`: pure projection of the existing graph and already-authorized `Person[]` profiles. Only loaded, unmasked node IDs participate; no new RPC, migration or write. Parent sets do not create marriages. Legacy core copies of an explicit marriage are consolidated without merging distinct unions.
- `ConstellationTimeControls.tsx`: responsive controls, year events and complete selected-person history (paged). The canvas changes only presentation; moving the slider does not fetch, launch a worker, reset zoom or move nodes.
- A person can be marked as living in a year when dated evidence supports it. Missing death dates are not evidence of being alive today. Birth and death years are inclusive, not day-level snapshots. Conflicting birth/death facts yield an unknown state with a warning.
- Places are the latest dated **event locations up to the selected year**, including ties; they are not inferred residence addresses or migration routes. Open-ended dates remain in history, rather than generating an event in every year. A ring also marks an approximate event's nominal year; the event text explains uncertainty.
- The chart is only the currently loaded neighborhood, not statistics for the entire project. The RPC's `badges.privacy = masked` marker blocks all detailed temporal profile data, even if a full profile was previously cached. `isPrivate` alone is a record setting, not evidence that the current viewer lacks access (the owner may view their private records).

## Stage 3 — Місця

The third mode is a **schematic atlas of recorded places**, not a geographic map. The shared night/light sky and inherited person colors keep the view consistent with the other modes. Place circles show unique person counts; selecting a place opens its source spellings, people and dated/undated events. Selecting a person highlights their place observations, with explicit emigration/immigration markers. Event links navigate to **Час**; person actions open the existing card or change the neighborhood focus.

- `constellationPlaceIdentity.ts`: only a confirmed `placeId` unites historical aliases. Unresolved identical text is visibly marked as a spelling group, not an assertion of geographic identity. Different confirmed IDs never merge merely because the villages share a name. Legacy residence text is kept intact; commas are not guessed settlement boundaries.
- `constellationPlaces.ts`: pure projection of the same scoped temporal model. No additional RPC, external map service, geocoder, writes or schema changes. Privacy-masked profiles stay excluded. A shared event contributes once to the event count, while each participating person contributes once to place membership.
- Arrows connect adjacent non-overlapping dated observation groups **for one person only**. Equal years, overlapping periods or conflicting simultaneous places do not receive an arbitrary ordering, and ambiguous groups are not bypassed. Approximate, undated and one-sided records remain listed without guessed arrows. A chronological connection does not prove a direct move, residence, travel distance or compass direction.
- `ConstellationPlacesCanvas.tsx`: event-driven Canvas rendering, at most 120 place circles and 600 aggregated links. The selected person's links have priority. Omitted content is indicated; the complete loaded-place directory and person history remain available. Finding an omitted place pins it into the canvas. HTML place names stay readable while zooming.
- `ConstellationPlacesPanels.tsx`: historical-name search, selected-person filter, optional other-person links, paged people/events/place directory and uncertainty explanations.
- The modes share one persistent camera viewport. Place layout and family/time layout remember their own camera position and zoom. Selecting a person without changing the place filter does not relayout the atlas. Mode switches, place selection and filters do not reload the neighborhood or restart its worker.

## Presentation stage — Нічне небо / Презентація

Stage 4 **Докази is explicitly skipped at the user's request**. The presentation stage operates on the existing three modes, not an evidence graph.

- Default **Нічне небо** theme: dark navy/black surfaces, cyan/violet sky, luminous family nodes and lines, modern high-contrast labels. **Параметри → Оформлення** switches back to **Світла**, removes the sky or freezes its stars. Saved branch hues are adapted for dark-background luminance without changing the user's stored palette or other charts.
- `constellationCinema.ts`: immutable theme adaptation, deterministic presentation highlights (up to 60 stops sampled across the loaded sequence, including both endpoints), smooth camera interpolation and bounded decorative star positions. Family stops use real unmasked people; time stops preserve original date qualifiers; place stops honor the current place filter. Stars are decoration, not additional people or actual astronomical coordinates.
- `ConstellationStarfield.tsx`: separate Canvas layer, at most 220 stars, capped 30 paints/second and 3 megapixels. The background never causes React/graph/layout-worker updates. Static nebula and glow sprites are cached per size/theme. No external image or graphics library. Turning motion off, hiding the document or unmounting stops animation; `prefers-reduced-motion` is respected and updated live.
- **▶ Презентація** expands the same window, hides editing/navigation panels and keeps story/transport controls outside the diagram. Prev/next, pause/resume, 4/7/12-second timing, keyboard controls and explicit exit remain accessible on narrow and landscape screens. Tours stop at the final frame rather than looping forever. Large-scope sampling is identified in the counter, not presented as the full project history.
- `useConstellationFlight.ts`: short cancelable camera transitions; manual pan, wheel/pinch or keyboard navigation pauses the automatic tour. Hidden tabs pause the tour and do not resume it unexpectedly on return. Reduced-motion mode begins paused, uses immediate camera changes and keeps manual/slideshow navigation available. Exiting restores the previous camera, selection, year and fullscreen state.
- `constellationFrameExport.ts`: **Кадр PNG** saves the currently visible diagram, readable labels, current caption and Tracker Rodu logo/name. It is a local snapshot, not a video or complete-tree export; nothing is uploaded or publicly shared. No new API requests or database migrations are required.

## Browser fullscreen

The toolbar's **Рух неба** and **Параметри → Рух зірок і комет** control the same motion switch. The sky now includes sparse comet fly-bys with random directions, colors, timing and durations, using the shared `appearance/skyComets.ts` model. Comets stop with star motion, hidden tabs and reduced-motion mode. The saved tree motion setting supplies the initial choice; changes within the constellation remain local to its window.

- The header's **На весь екран** action requests native browser fullscreen for the entire dialog, not just the canvas. Search, modes, colors, settings, details and the close/exit buttons stay inside it. The header remains outside the mobile scrolling area.
- `useConstellationFullscreen.ts` tracks `fullscreenchange`, scopes cleanup to this dialog and handles pending requests, close/unmount and refused exit. Unsupported or denied entry expands to the browser viewport with an explicit explanation; no reload, new neighborhood request or camera reset is needed.
- The exit button and Escape return to the window. Opening a person card exits fullscreen before navigating away. Presentation also enters native fullscreen; its explicit finish restores a previous fullscreen work session, while a browser/Escape exit never re-enters fullscreen automatically.

## Verification

```sh
npm run typecheck
npm run build
node --test test/familyConstellation.test.ts test/familyConstellationTime.test.ts test/familyConstellationPlaces.test.ts test/familyConstellationCinema.test.ts test/familyConstellationFullscreen.test.ts
```

Browser checks use the real React component with an injected synthetic neighborhood client (no production records or credentials). Verify all three modes at desktop, 390px/320px and landscape sizes; slider keyboard/touch interaction; unchanged request/worker counts and camera during year changes; no-date, approximate-date, private-person and 1,000-person cases. For places also verify historical aliases, person highlighting, filters, separate mode camera memories, navigation back to time, no-place fallback, touch selection and search for an omitted place in a 1,000-person/2,000-place fixture. Existing graph regression tests must still pass.

For presentation also verify actual changing sky pixels without graph repaints; frozen frames with motion disabled; pause/play/tempo/keyboard/manual takeover; separate modes; camera/selection restoration; PNG download and visual output; reduced-motion, simulated visibility changes and complete cleanup on close. Legacy no-idle-loop browser tests now use reduced-motion mode; the dedicated cinema check exercises enabled motion separately.

No production deployment is implied by these local checks. GitHub Pages configuration and Supabase schema are unchanged. Real geographic mapping, the skipped evidence graph and video recording/export are not included.
