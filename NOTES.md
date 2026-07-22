# CrossCanvas - Project Notes & Decisions

Context and rationale that isn't obvious from the code or commit history.
For *what* exists, see `CHANGELOG.md`; for *how to host*, see `README.md`.
This file is the durable record of *why* - read it first when picking the
project up fresh.

## What this is
CrossCanvas is a dependency-free, browser-based network/application diagram editor.
Pure HTML/CSS/JS, **no build step, no backend, no frameworks**. It runs straight
from `file://` or any static host. All logic lives in a single IIFE in `app.js`
(~14k lines); `devices.js` holds the 55 bundled stencils (see the stencil
sections below for the set's history); `index.html` + the stylesheet provide
the shell.

## Architecture decisions
- **`app.js` is intentionally monolithic.** Breaking it into modules was
  considered and explicitly declined - keeping one IIFE preserves the
  zero-build, drop-in-and-serve property and avoids a module loader / bundler.
  Don't "modernize" this into ES modules without a deliberate reason.
- **No build, no dependencies - keep it that way.** No npm, no transpile step.
  The publish directory is the repo root. Any feature must be implementable in
  vanilla browser JS.
- **Single source of truth** is the `state` object in `app.js` (devices,
  connections, zones, textBoxes, images, templates, selections, view, etc.).
  Rendering is SVG with layered `<g>` groups (zones → images → connections →
  devices → overlay).
- **Mouseup is bound to `window`, not the canvas**, so a drag always ends even
  when released over the Properties pane or off-window. Don't move it back.

## Security & privacy posture (important - sensitive diagrams)
Diagrams may contain sensitive production detail, so the threat model matters:
- **Zero outbound network calls with diagram data.** All images are embedded as
  `data:` URIs; load/save/export are entirely client-side. This was security-
  reviewed and must remain true. Don't add fonts/CDNs/telemetry/analytics or any
  fetch of diagram content.
- **`isSafeImageURL()`** restricts all image ingestion to `data:image/` URLs
  (diagram JSON, localStorage, bundled library).
- **Untrusted HTML (Gliffy labels) is parsed inert** via
  `DOMParser.parseFromString(html, 'text/html')` - never `innerHTML` - so
  scripts / `onerror` / subresource loads can't fire, regardless of CSP.
- **Visio `.vsdx` import is local-only and inert.** The package is unzipped
  in-browser (no library - see the import section below) and every XML part is
  parsed with `DOMParser` (`application/xml`); nothing is fetched and no markup
  is ever assigned via `innerHTML`. Placeholder-stencil names are escaped into
  generated SVG and consumed as `<image>` (scripts can't run in image-context
  SVG); embedded media is not ingested. The unzip caps decompressed output
  (40 MB/part, 100 MB total, aborting mid-stream) so a decompression-bomb
  `.vsdx` fails with an alert instead of hanging the tab.
- **Export filenames** run through `sanitizedTitle()`.
- **CSP / security headers** are supplied by the host: the repo ships a
  `web.config` for IIS (strict CSP + MIME maps, incl. `.xcanvas` for
  `?board=`); other hosts replicate it in their own config. No
  `eval` / `Function`.

## Hosting model
- **Sensitive / production → local hosting only**, on trusted devices /
  network segments, served over HTTPS by IIS (`web.config`) or Apache. Storage
  is local/encrypted on trusted devices.
- **Netlify is for non-sensitive testing/demos only** - replicate the security
  headers in the host config and mark the site `noindex`. Never push sensitive
  diagrams to a public/Netlify host. (Our own `netlify.toml` stays an
  untracked local file - it's specific to hosting the demo link.)

## Scope decisions (deliberately *not* done)
- **No mobile / touch EDITING.** Tested as janky; proper support would need
  Pointer Events, `touch-action`, and a replacement for HTML5 drag-and-drop.
  Out of scope by decision. Small screens do get a VIEWING-first mode
  (media query, max-width 700px): the sidebar starts hidden behind a toolbar
  toggle so the canvas gets the full width, the menu bar wraps, and a
  one-time dismissible notice sets the "browse here, edit on a PC"
  expectation - most phone visitors arrive from the demo link to look.
- **No obstacle-avoidance connection routing** - an earlier version could
  infinite-loop and lock the page; removed on purpose. Connections route
  directly / orthogonally.

## Behaviors worth knowing before editing
- **Alt = fine snap (¼-grid / 5px)** across move, resize, multi-drag, and
  connection bends/endpoints. Bend handles keep their fine position on release;
  the snap-back-to-natural removal is skipped while Alt is held. Alt also
  **bypasses alignment guides** while dragging - guides are on by default
  (toolbar toggle next to the grid button, persisted; a saved opt-out is
  honored) but aggressive auto-snap annoys precision work, so Alt must
  always win.
- **First-visit sample diagram** is built at runtime from the stencil library
  (`buildSampleDiagram`) and gated on `localStorage 'crosscanvas-visited'`. Autosave
  restore takes precedence over showing the sample. A second, larger showcase
  (`buildComplexSampleDiagram`, File → Load Complex Sample) demonstrates the
  multi-site idiom: VLAN zones, WAN/VPN dashes, wireless hops, a non-square
  device and a per-span-colored legend - same runtime construction, connected
  via `apAt(node, fx, fy)` fractional lookups instead of hardcoded AP indexes.
  It deliberately draws from every stencil category (security tap, NAC/LDAP/
  monitoring servers, wireless controller, satellite backup WAN) so one board
  proves the library's breadth. Both samples inherit the active theme.
- **Autosave** → localStorage (4s debounce, key `crosscanvas-autosave`), restored on
  startup with a prompt; cleared on Save / New.
- **Open Recent** → localStorage (`crosscanvas-recents`): whole slim-v6 snapshots
  of the last 10 saved/opened diagrams (deduped by title, 400KB per-entry cap
  for quota safety), flyout rebuilt when the File menu opens; a Clear Recent
  entry (only when the list is non-empty) removes the key. Refs resolve on
  load like any v6 file.
- **Save excludes default/bundled templates** to keep files small; they're
  re-merged on load with ID remapping.
- **Global defaults live in the sidebar "Default Settings" section**
  (collapsed by default; session-only, not persisted): Font family/size/color,
  Device Size, Device Color (tint via `tintSVG`, null = stencil colors),
  Device Background (frame face for new devices), Zone Color (fill, null =
  classic light blue), Zone Border Color (`defaultZoneBorder()`: explicit
  value wins; null = the device-frame blue `#2d67b9`, or
  `darkenHex(fill, 0.35)` when a custom Zone Color is set - the border
  swatch tracks the effective value while on auto), Attachment Points. Defaults apply to **interactively created objects
  only** - imports keep their own conventions (classic 8-point APs, plain
  colors) for fidelity with the source file. The toolbar **T** button (left
  of Pan) arms a one-shot 'text' tool: the next canvas click places a
  ready-to-type text box there, then the tool returns to Select (Esc
  disarms). It shares the select/connect/pan tool plumbing in `setTool`.
- **Attachment-point layouts are corner-anchored**: every corner always gets a
  point and the rest space evenly along each side between the corners (an even
  perimeter walk only hits corners on squares). Count 8 emits the classic
  corners+midpoints layout **in the same index order as before**. **Resizing
  SCALES the existing APs** (`redistributeAPs(node, oldW, oldH)`) instead of
  regenerating a distribution - identical for standard layouts (the walk is
  proportional) and it preserves imported exact-anchor APs, which a
  regeneration tore off their contact points; the per-object panel sliders go
  through `setNodeAPCount`, which does regenerate and re-snap each attached
  connection to the nearest new point.
- **Diagrams save as `.xcanvas` (plain JSON inside)**; legacy `.json` loads
  forever (the load path content-sniffs). `serializeDiagram` is the single
  source of the format - Save delegates to it (a private copy once shipped
  without `groups`). On load the filename wins over the embedded title.
- **Saved images are slimmed two ways (format v6)**: library icons
  (`isBundled`: devices.js + customdevices.js) save as `'@<name>'` references
  resolved from the startup-loaded library - a missing entry degrades to the
  generic template icon; everything else (personal imports, tinted `image`s -
  their untinted `originalImage` still refs by name - pasted images) dedupes
  into `imageTable` as `'#<key>'`. Neither prefix can start a real data URI.
  `applyDiagramData` resolves refs before the `isSafeImageURL` checks, and
  bundled templates load before any restore/load path runs (init order
  matters). Cut a 14-device test diagram from 1.26 MB to 10 KB and equally
  shrinks the localStorage autosave (5 MB cap). Old files load unchanged;
  **files saved by v6 don't render icons in pre-v6 builds** (acceptable:
  local tool, update in place). Trade-off accepted: files are no longer
  fully self-contained by default - they assume the app ships its stencil
  library. **File → Save with Embedded Images** is the escape hatch: it
  passes `embedImages` to `serializeDiagram`, which skips the by-name
  mechanism so library icons ride in `imageTable` like everything else
  (self-contained and still deduplicated; loads identically).
- **Bundled icons are borderless glyphs; the APP draws the stencil frame**
  (`renderDevice` + export `drawDeviceNode`: white face `rgb(255,254,254)`,
  blue border `rgb(45,103,185)`, stroke 16/300 and radius 30/300 of the min
  dimension, inset half a stroke so APs sit on true edges). Regenerate
  devices.js with the frame-strip script pattern (remove the two frame paths:
  white base `d` starts `M300,30.271`; the ring is either the compact `ZM284`
  variant of the same start or a generated fat path starting `M269.…` with
  >5k chars of `d` - some icons keep glyphs inside the same Background group,
  so strip PATHS, not the group). The v4.0 expansion set (32 icons from
  ecceman/affinity `svg/square/blue`) also went through prolog/DOCTYPE
  removal, inter-tag whitespace collapse, and 2-decimal coordinate rounding
  (~79% smaller, visually lossless at stencil sizes).
  `tintColor` colors the frame directly + tints the glyph; `iconBg` shades
  the face (**Device Background** in Device Properties; `DEFAULT_ICON_BG` in
  Default Settings applies it to newly placed devices). TEMPLATE_ICON is an
  empty glyph - the frame IS the generic visual. Embedded old framed icons
  render a harmless same-color double frame. **Selection is a separate
  element**: `.device-selection-outline` (always in the group, shown by CSS
  on `.selected`/`.multi-selected`) - never restyle the `.device-border`
  stroke for selection, that erases the frame; the marquee fast path only
  toggles classes, so the element must pre-exist.
- **Imported icon-set SVGs normalize to the stencil blue**
  (`normalizeImportedSVG`, Import Device Image / SVG path only - NOT
  library import): monochrome art (`currentColor` / dark neutrals, e.g.
  Lucide/Tabler) recolors to `rgb(45,103,185)`; art with any chromatic
  color is left untouched; icons relying on the default black fill (no
  fill/stroke attrs at all) get a root fill. Rationale: `currentColor`
  resolves to BLACK inside an `<image>`, and `tintSVG` preserves neutrals -
  un-normalized mono icons render black and are untintable. After
  normalization the blue is chromatic, so Device Color works.
- **Stencil libraries are script-tag globals by necessity**: `file://` blocks
  `fetch()` of local JSON, so `devices.js` (base bundle) and the optional
  `customdevices.js` (site/team layer, gitignored - environment-specific) are
  the only universal loading mechanism. Export Device Library emits the
  `customdevices.js` format (imported stencils only); Import Device Library
  reads that, legacy `devices.js` exports, or raw JSON arrays.
- **Stacking is two-tier by design**: object *type* fixes the render layer
  (zones → images → connections → devices & text boxes) and cannot be
  overridden - it encodes how network diagrams read, and users can't bury a
  device under its own zone. Within a layer, zones/images stack by array
  order; devices and text boxes share one layer and interleave on a
  per-object `stackZ` key (undefined sorts front-most, so new objects land on
  top and untouched legacy diagrams keep their historical order - the sort is
  stable). `stackZ` materializes for the whole shared layer on the first
  arrange and rides through save/undo like any field. Arrange verbs accept
  multi-selections (relative order preserved). There is deliberately **no
  per-object "Layer" dropdown** (removed - it renumbered itself and read as
  layers when it meant z-order) and **no named/user layers** (considered and
  declined; the type tiers already provide correct default stacking).
- **Canvas tiers can be hidden/locked** from the Layers menu (eye/padlock per
  tier). This is *view state*, deliberately not part of the document: not
  saved, not in undo snapshots, reset on load/new/import. Hidden = not
  rendered, not selectable (marquee/Ctrl+A test geometry, so they need
  explicit guards - as do `findNodeForPoint` and the alignment-guide
  candidates), excluded from raster exports (WYSIWYG). Locked = visible but
  inert (`pointer-events: none` + the same selection guards) - the headline
  use is locking Zones so marquee/clicks inside a zone reach its contents.
  Creating an object in a hidden tier auto-shows the tier (an invisible drop
  reads as a bug). Tier toggles `stopPropagation` so the menu stays open for
  exploratory clicking.
- **Themes are a chrome palette + a Default Settings seed** (`THEMES` /
  `applyTheme`, picker next to the Dark toggle, persisted as
  `crosscanvas-theme`): the chrome layer sets the `--se-*` CSS variables (plus
  `--se-active` for the active tool button - don't hardcode chrome colors);
  the canvas layer seeds Device Color / Zone Color / Zone Border Color BY
  DRIVING THE REAL Default Settings inputs (dispatched `input` events), so
  the live previews fire and every per-control Reset keeps meaning "back to
  classic". Classic = clear the variables + click the resets. Imports and
  existing objects are never touched. In LIGHT mode a theme colors only the
  chrome and the object defaults; in DARK mode the sidebar/panels/context
  menus read `var(--se-dk-panel, var(--se-panel))` etc. - so a normal
  (dark-chrome) theme defines no `--se-dk-*` and falls back to its chrome
  palette (single source, per-theme hue), while a LIGHT-chrome theme
  (Glacier) sets `--se-dk-*` to real dark values to keep a dark workspace
  in dark mode with a light top bar. The old fixed purple-navy dark family
  was swept onto the vars - never hardcode dark-mode colors; add any new
  dk var to THEME_VARS so it clears on switch-away. The whole top bar is
  theme-driven (tool-btn/hover/separator use chrome vars, not hex). The
  canvas/grid take the per-theme `--se-canvas-dark`/`--se-grid-dark`. `surfaceIsDarkAt` keeps a
  representative constant for the canvas base - every theme's dark canvas
  is comparably dark, and containing zones dominate the blend.
- **Dark-mode adaptive colors are SURFACE-AWARE** (`surfaceIsDarkAt(x,y)`:
  dark canvas #2a2a3e blended with every containing zone by fill-opacity,
  luminance < 140 = dark): device/image labels and text boxes flip
  near-black→white only when their anchor sits on dark surface; connection
  strokes vote across from/mid/to samples (≥2 dark flips). Imported
  diagrams lay LIGHT zones over the dark canvas - a blind flip made labels
  vanish inside them. Toggling dark re-renders connections + devices/text
  boxes + images (flips resolve at render time). Colored text/lines never
  flip (isDark gate); per-span colors ride on tspans and survive the flip.
  Exports are unaffected (always light-canvas, drawn from model colors).
- **Font families are curated system stacks only** (`FONT_STACKS` in app.js) -
  webfonts would violate the zero-outbound-network posture. Objects store a
  short key (`fontFamily`); absent = historical default (SVG inherits the app
  font, exports draw generic sans-serif - a long-standing mild mismatch that
  explicit families avoid, since SVG and canvas then use the same stack). Any
  new text-drawing code must thread the family through BOTH the SVG attr and
  the canvas `ctx.font` string, plus the measurement helpers
  (`measureSpansWidth` / `ctxSpansWidth`).
- **Devices resize freely (zone-style)**: five handles (`both`/`r`/`b`/`l`/`t`)
  stretch w/h independently; `setDeviceDims(device, w, h)` is the setter
  (there is no square-only `setDeviceSize` anymore) and the panel exposes
  W × H inputs (`device-w-input`/`device-h-input`); the × scale buttons go
  through `scaleDevice`, which preserves aspect. APs regenerate from the
  corner-anchored layout on resize, same as zones.
- **Waypoint connections get drag handles**: `.conn-waypoint-handle` per
  waypoint on selected connections (`state.draggingWaypoint`, fine-grid
  snap). The mousedown branch checks waypoint handles BEFORE bend handles -
  waypoint conns show no bend handles, but keep the order if that changes.
- **Spans can carry per-character colors** (`span.color`, optional): imported
  Gliffy HTML colors land here (`htmlToSpans`), all four SVG tspan renderers
  and all five export `fillStyle` sites prefer `span.color` over the object
  `fontColor`, gated by `isSafeCSSColor` (hex/rgb()/rgba() only - span colors
  are untrusted import data and get emitted into markup). The whole-label
  Font Color controls call `clearSpanColors(obj)` so recoloring snaps the
  entire label predictably (draw.io behavior).
- **Vertical label layout defaults away from the node**
  (`effectiveVAlign`): no stored `labelVAlign` + position top → text stacks
  upward (valign bottom), position bottom → downward, position center →
  CENTERED (imported labeled boxes used to top-align). Call sites must pass
  the RAW `labelVAlign` (no `|| 'top'` fallback) or the smart default never
  fires; files with an explicit stored value keep it.
- **Label alignment is two-valued**: `labelAlign` (`'auto'` default) is an
  explicit multi-line justification override; auto follows the label position
  (side labels justify toward the node - `impliedLabelAlign`). Justification
  re-anchors lines *inside* the label block (`justifiedLine` + span-width
  measurement) so the block never shifts off its position anchor. Applies to
  devices/zones/images (`renderMultiLineLabel` + `drawObjLabelToCanvas`),
  connection labels and annotations (`ann.align`, default center); text boxes
  keep their explicit `textAlign`. The panel segmented controls show the
  implied value as active when auto; clicking the active value toggles back
  to auto.
- **Selection model** has both singular (`selectedDevice`, …) and multi
  (`selectedDevices`, …) forms, plus `selectedAnnotation` (`{connId, annId}`)
  for connection annotations. Property panels live in `properties-host` and are
  listed in `PROP_PANEL_IDS` for the right-pane auto-show observer - add new
  panels there.
- **Groups are persistent multi-selections**, not container objects: selecting
  a group populates the regular multi-selection arrays, so drag, align, batch
  edit, copy and delete need no group-specific code. Click a member = whole
  group; **Ctrl+click = subselect one member** (double-click was unavailable -
  it edits labels). One group per object, no nesting; `pruneGroups()` keeps
  membership consistent after deletions and loads.

## Known rough edges (parked, low priority)
- (none currently - the panels-stale-after-undo issue was fixed by making
  `restoreSnapshot` re-select the surviving single selection through the
  normal `select*` path, which repopulates its panel; multi-selections still
  clear on undo by design.)

## Batch editing (multi-select + Bulk menu)
One batch-edit panel (`batch-panel`) powers two entry points, deliberately, to
avoid two parallel systems:
- **Multi-select** (marquee / Ctrl- / Shift-click) → the panel shows a section
  per selected type, and a change applies to every element of that type at once.
- **Bulk menu** → the same panel scoped to *all* objects of a type (canvas-wide).

Things to know before editing:
- Controls default to "keep"/blank so merely opening the panel mutates nothing;
  a value is written only when the user sets it, and each applied control is one
  `pushUndo()` step.
- `state.selectedConnections` was added for connection multi-select (only the
  singular `selectedConnection` existed before). The marquee includes a
  connection when **both** its endpoint devices are inside the box.
- Ctrl/Shift-click extends a multi-selection for every type - devices, zones,
  connections, text boxes and images (Ctrl toggles, Shift adds; the prior single
  selection folds into the multi set). Selections accumulate across types, so a
  device + a connection can be batch-edited together.
- The Images section's Width control scales each image's height to preserve its
  aspect ratio (devices stay square; images don't).
- Device "color" is the existing icon tint (`tintSVG`/`tintColor`), so only SVG
  icons recolor. The font controls span labels + connection annotations + text
  boxes together (annotations follow their connection into `batchTargets`).
- `batch-panel` is listed in `PROP_PANEL_IDS` so the right-pane auto-show
  observer treats it like any other property panel; the single-object `select*`
  functions hide it, and `openBatchEdit` hides the single-object panels.

## Diagram import (Gliffy & Visio)
Two importers feed the same `state` model and share conventions: stencil-name →
bundled-template mapping with a fuzzy fallback, plus a post-import summary.
**Gliffy devices keep their source dimensions** (non-square; the renderer
letterboxes the icon) with 16 APs - Gliffy's implicit quarter grid - and line
endpoints resolve the file's exact fractional anchors (`constraints.*.px/py`),
injecting an AP at the precise contact point when no existing AP is within
2px (`mapToAP`). Gliffy stores no per-object AP count; the per-line fractions
are the ground truth. Label placement comes from the Text child's
`hposition`/`vposition`/`valign` (`gliffyLabelPos`: hposition left/right wins
first → left/right, then above→top, below→bottom, none+top→top-inside,
none+middle→center); per-span HTML colors survive into the spans model;
ortho/hand-routed lines import as Rounded, straight lines as Straight.
**Visio devices keep their source ASPECT** (per-axis median normalization:
long axis clamped 40-200, short axis from the source aspect with a 16px
floor) - bus bars import as bars; the old aspect>2 force-square rule is
gone. **Visio geometry connectors resolve exact anchors** via the shared
`mapToAP` (now top-level, next to `nearestAPIndex`): the contact point is a
fraction of the SOURCE box (`nodeSrc` map - devices resize around their
pins, so page coords don't map directly onto the imported node); zones use
their own box. Glued `<Connects>` hub edges have no endpoint geometry and
still use center-facing `nearestAP`.
**Gliffy devices with an INSIDE label match the "Blank" stencil** (the empty
glyph that replaced VRF - the app-drawn frame is the whole visual): the
source drew a labeled box, and stencil art under centered text reads as a
clash; in practice this catches Gliffy's cloud-with-internal-label idiom.
The Icon dropdown upgrades one to a specific icon. Visio is untouched (its
devices always label at bottom). Visio devices stay median-normalized
squares on purpose (different source idiom: stencil icons, not footprints).
**Unmatched types get the generic `TEMPLATE_ICON`** (a compact recreation of
`Icons/Template.svg`: the set's white-rounded-square-blue-frame look) carried
inline on the device with `templateId: null` - deliberately NOT a palette
template, so unknown types never spam the device list or get saved as
`Gliffy_*`/`Visio_*` stencils; the summary lists the unmatched type names and
points at the Icon dropdown. Both live in `app.js`. Both resolvers still prefer
non-`isDefault` stencils - the built-in `Default_` templates were removed once
`devices.js` made them redundant, but the guards stay as harmless no-ops so
legacy diagrams/localStorage that still carry `isDefault` entries resolve the
same way (old diagrams render regardless: devices embed their images inline).

- **Visio `.vsdx`/`.vsdm` is an OPC package** (a ZIP of XML parts). We unzip it
  **without any dependency**, to honor the no-deps rule: parse the ZIP central
  directory by hand and inflate entries with the browser's native
  `DecompressionStream('deflate-raw')`. XML is read with `DOMParser` (inert).
  Renderable `visio/media/` parts (PNG/JPEG/GIF/BMP) are extracted as data
  URIs in the same parts map; **Foreign shapes** resolve them through the
  page's own rels (`visio/pages/_rels/pageN.xml.rels`) and import as pasted
  images at true footprint (EMF/WMF isn't extracted - not browser-renderable
  - so those Foreign shapes still skip). Foreign images deliberately do NOT
  attract connector-end snapping (a poster image would swallow endpoints).
- **Coordinate conversion**: Visio uses inches with a bottom-left origin and Y
  up; shapes convert to pixels (96/in) with Y flipped by page height. Most shape
  geometry is **inherited from masters**, so the importer resolves a master's
  Width/Height when a placed shape omits them.
- **Mapping**: shapes with a stencil master → devices (source aspect kept,
  median size normalized to Default Size - the median IGNORES sub-icon
  shapes < 24px, since vector-art exports carry swarms of 6px mastered
  decoration dots that drag it to dot size and explode sizeNorm; a median
  still below 40px means the page has no stencil icons at all, and it
  imports at its own scale, unnormalized); container shapes
  (`User.msvStructureType = "Container"`), masterless filled/large boxes,
  oversized boxy masters (VNet-style backgrounds) and **border/frame masters
  matched by name** (`box|square|rectangle|frame|border|background`,
  "WhiteBCK", "Subnets" - Azure exports draw containers as stencils, which
  the masterless-box rule can't see) → zones. Zones carry their SOURCE
  colors: fill `FillForegnd`, opacity `1 − FillForegndTrans` (Azure region
  bands = strong fill at ~0.9 trans), border `LineColor`; `LinePattern 0`
  (borderless) blends the border toward white by the same transparency;
  unfilled boxes render white (the cards they are), not the old uniform
  gray. Shape cells first, master-sheet fallback. **Zone label position
  comes from the text block** (`TxtPinY`/`TxtLocPinY`/`TxtHeight` +
  `VerticalAlign`; master fallback scaled by instance/master height):
  compute the text anchor in shape-local Y-up coords → above/below the
  shape = top/bottom, else top 30% = top-inside, bottom 30% =
  bottom-inside, else center. Visio's DEFAULT (no cells at all) is a
  middle-aligned block spanning the shape = a CENTERED label - don't
  hardcode Top. Masterless text-only shapes → text boxes. **Masterless groups flatten recursively** (children are real
  content, offset by the parent's local origin) - EXCEPT icon-sized groups
  (≤1.3in, aspect ≤2.2) of 2+ textless vector children: those are pasted
  vector icons (modern Azure exports carry no stencil masters for icons),
  and each imports as one **Blank device** at true footprint
  (`looksLikeIconGroup`, decided at walk time so the group isn't recursed;
  unnameable - the Icon dropdown is the upgrade path). Mastered shapes stay
  atomic - their nested children are stencil-icon internals.
- **Tiny unlabeled mastered shapes are skipped as badges** (NSG shields,
  network-manager markers, UDR tags: below max(34px, 55% of the median
  stencil size)) - they're corner decorations in Visio, and size
  normalization would inflate them to Default Size clutter. Labeled small
  shapes are kept.
- **Connector styling imports**: `LinePattern` maps onto the app's five dash
  styles and `LineColor` is used when it's a plain hex value (shape cell
  first, then the connector's master sheet) - Azure exports lean on dotted
  peering lines and green "forced tunnel" dashes for meaning. Thickness stays
  the panel default (source hairlines read as broken in CrossCanvas's idiom).
- **Background pages** (`Background="1"`) are excluded from the page picker -
  they hold watermarks/frames, and offering them skewed the default pick.
- **Connections come from two sources**: glued `<Connects>` (hub-style
  ownership) and - the norm in Azure/architecture exports - **unglued 1-D
  connectors imported from Begin/End geometry**, ends snapped to a nearby
  device footprint or zone border, else left free-floating. `<Connect>` rows
  glue a specific END (`FromCell` Begin*/End*) - never assume file order
  (one-end-glued connectors collapsed onto one device and got dropped;
  End-first rows swapped endpoints). **Routed paths import** via
  `connectorWaypoints`: the connector's own Geometry rows → waypoints →
  `convertWaypointsToBends` after state assembly. Gotchas encoded there:
  dynamic connectors inherit their MoveTo (rows start at LineTo - the first
  point is Begin only when an explicit MoveTo says so); ANY row may omit a
  coordinate cell that hasn't changed from the previous point
  (omit-if-unchanged - carry the running point, seeded from Begin in
  shape-local coords); straight line masters pad with duplicate/
  collinear rows (normalize against the real endpoints before calling a
  route "bent"); small `ArcTo` bows are corner rounding or line-jump hops -
  flatten to their endpoint; big bows / other curve rows / rotated frames /
  mid-path MoveTos bail to the straight import. End segments re-align with
  the resolved AP (`alignEndSegment`, small-delta axis, 24px tolerance)
  because the pin-centered resize slides contacts along the box edge; the
  same drift hits straight 2-point connectors that were axis-aligned in the
  source - those re-align too (free ends move outright; a device end
  re-anchors via a fresh `mapToAP` injection so shared APs are untouched;
  1-24px drift only, and only when the SOURCE Begin/End were straight).
  Plain two-point connectors still route straight by user preference.
- **Connection geometry has three mechanisms**, resolved centrally in
  `connRoutePoints` (every consumer - render, export, hit-testing, annotation
  placement - goes through it): auto-routing (`routing` + `generateWaypoints`),
  **manual bends** (`bends`, keyed by natural-route segment, user-draggable),
  and **manual waypoints** (`waypoints`, absolute intermediate points imported
  from hand-routed Gliffy lines). Waypoint connections show waypoint drag
  handles (no bend handles), translate their waypoints when both endpoints
  multi-drag together, and drop their waypoints on endpoint re-attach or when
  routing is set to straight (straight paths ignore intermediate points).
  **Imports convert waypoints → bends when lossless**
  (`convertWaypointsToBends`, run after both importers): the imported
  polyline must match the natural route's segment template EXACTLY - same
  segment count, same orientations - and the candidate bends are dry-run
  through `connRoutePoints` (ROUTE_EPS 0.75px), so conversion can never
  change the drawn path; no-op bends on the natural rail are pruned. Do NOT
  "collapse" shorter routes onto longer templates with zero-length
  segments: the path draws right but the model keeps phantom segments -
  stacked bend handles on one corner, hidden legs that unfold into jogs
  when dragged or when an endpoint moves (shipped briefly, reverted).
  Non-matching routes keep waypoints + waypoint handles. Related fix:
  `applyManualBends`/`captureBendOrientations` read segment orientations from
  the PRISTINE route (`naturalSegmentOrientations`) - an earlier bend can
  collapse the next segment to zero length, which read as vertical and let an
  adjacent-bend pair apply an x value to the y axis.
- **Scope decisions (deliberate):** icons are mapped to CrossCanvas's bundled
  stencils, **not** carried over - Visio embeds EMF/raster art the browser can't
  render. Legacy binary **`.vsd` is unsupported** (proprietary OLE would need a
  heavy dependency; save as `.vsdx`). CrossCanvas has one canvas, so a **multi-page**
  document prompts for which page to import rather than merging them.

## Data interop (direction)
- **Import/export security posture** (reviewed July 2026): imported text
  (labels, fields, CSV cells) reaches the DOM only via `textContent`/tspan
  and input `.value` - never `innerHTML` - so no import path is a DOM-XSS
  sink. Span colors gate through `isSafeCSSColor`; imported/loaded images
  gate through `isSafeImageURL` (Visio Foreign media is data:image/* with a
  hardcoded MIME, inert). Export sinks that emit untrusted values into a
  file another app parses are escaped: **CSV** neutralizes formula
  injection (leading `=@+-`/tab/CR that isn't a plain number → `'` prefix,
  in `exportCSV`'s `esc`); **draw.io** XML-escapes labels (double-escaped
  HTML), field attribute values (`xmlEsc`), field NAMES (regex-gated), and
  style strings (`xmlEsc(style)` - colors from a crafted file can't break
  the XML); device icons are base64'd so inherently safe. Known-accepted:
  a pathological Location path (~1000+ levels) could stack-overflow the
  recursive layout, but real depth is ~6.
- **Export as CSV** (`exportCSV`) is the first piece: one row per object,
  readable columns first (type/label/hostname/field columns/stencil/endpoint
  names), geometry next, styling + ids last. RFC 4180 quoting, UTF-8 BOM
  (written as the `﻿` ESCAPE - never a literal invisible char in source),
  CRLF for Excel. Device data fields become one column per distinct key
  (keys colliding with base columns are skipped); `hostname` = the explicit
  field or the label's first line.
- **Device data fields** (`device.fields`, ordered key→value object): ride
  through save/load/copy untouched - serializeDiagram copies devices
  wholesale, so no serializer change was needed. UI: the DEVICE DETAILS
  collapsible half of the device panel (`populateDeviceDetails` /
  `collectDeviceFields`; editor rows are the source of truth, collected on
  every input). Six STANDING fields always render (`FIXED_DEVICE_FIELDS`:
  Hostname, IP-Address, Serial-Number, Asset-Tag, Description, Location -
  label span + value input, stored only when filled) plus removable custom
  rows. Hostname's placeholder shows the derived label-first-line value.
  Both panel halves persist their collapse state
  (`crosscanvas-collapse-devprops`/`-devdetails`); Details defaults collapsed.
  The section nests INSIDE #device-panel so the Properties Left/Right
  switch carries it for free. GOTCHA: the headers share the sidebar's
  `.section-header` class for LOOKS only - the sidebar's own collapse
  wiring must select `.section-header[data-target]`, or it null-crashes
  the whole init on the panel headers (happened; silent page-load failure
  with no console capture - reproduce init crashes by re-evaling app.js
  in the page inside try/catch).
- **Export as SVG** (`exportSVG(showGrid)`): clone the live canvas SVG,
  strip interactive chrome + hidden tiers, crop viewBox to content bounds
  (+20px pad), size the bg/grid rects to the crop. ALWAYS light: dark mode
  bakes adaptive flips into the DOM as attributes, so the export re-renders
  the layers light, clones, then restores dark ("export as it appears" in
  dark is a possible future option, deliberately not default).
- **Inventory import** (`importInventoryCSV` + `parseCSV`, File menu):
  the column spec is STABLE - the user builds external formatters against
  it (documented in the code comment above the function): label / stencil /
  the six standing fields / x,y / anything-else-is-a-custom-field.
  `Location` paths (`/` or `|` delimited) build a zone tree; layout is
  recursive shelf-packing (`measure` bottom-up sizes, `place` top-down
  positions; device grids ≤4 wide, parents wrap children toward a
  wide-screen aspect; parent zones near-white `#f7f9fc`, leaves take the
  zone-fill default). Stencils resolve through `resolveVisioTemplate`
  (vocab + fuzzy, Blank fallback). Default Settings apply to created
  objects (deliberate - no source styling exists). CSV export's device
  columns are designed to be re-importable (round-trip symmetry).
- **draw.io export** (`exportDrawio`): uncompressed mxGraph XML. Gotchas
  encoded there: draw.io styles are `;`-delimited, so data URIs inside them
  must drop the `;base64` marker (draw.io's own convention - `styleURI`);
  vertices REQUIRE `vertex="1"` or draw.io ignores them; devices composite
  frame+glyph into one SVG data URI (no two-layer icon concept); AP
  fractions ride as `exitX/exitY/entryX/entryY`; route points as
  `<Array as="points">`; free ends as source/targetPoint mxPoints; fields
  as an `<object>` wrapper (label attr + one attribute per field = Edit
  Data); labels are HTML (`<br>`, `<b>/<i>/<font color>`) double-escaped
  into XML attributes.
- **Agreed longer-term direction** (see memory `data-interop-roadmap`):
  native .vsdx export is feasible (CompressionStream exists for a no-deps
  ZIP writer) but large and last - the draw.io bridge covers Visio
  portability meanwhile; a future `connects-to` CSV column could pre-wire
  connections without placing anything (routes re-flow during manual
  layout).

## Dialogs
- **`showDialog` (native `<dialog>`) is the house modal** - promise-based,
  themed via the chrome CSS vars, body accepts a string / node / function
  receiving `close(value)` for interactive bodies (the Visio page picker).
  Import summaries and the page picker use it; **destructive confirms stay
  native `confirm()`** on purpose (blocking semantics their call sites rely
  on). Note for import tests: stubbing `window.alert`/`prompt` no longer
  covers imports - drive `#app-dialog` instead (click `.dialog-list-item`
  rows / `.dialog-btn`).

## Local development (preview)
Serve the folder at `http://localhost:3000` for preview testing. `python -m
http.server` works, but the browser often serves a **stale `app.js`** after edits
(heuristic caching with no cache headers), which silently hides changes. An
optional local no-cache server - `.claude/devserver.py`, run via the same launch
config - sends `Cache-Control: no-store` so reloads always pick up edits. It's a
local dev aid, deliberately **git-excluded and not part of the project** (the
committed `launch.json` stays on `http.server`; production is IIS/Netlify). If you
ever see changes not appear, that's the cache - hard-reload or use the no-cache
server.

## Working conventions (with Claude / contributors)
- **Commit only when explicitly asked.** Don't auto-commit; the user runs work
  in the tree and commits at chosen points.
- **Verify previewable changes in the browser** before reporting done (the
  preview server caches `app.js` - restart it if changes don't appear).
- Match the surrounding vanilla-JS style; no new tooling or dependencies.

## Portability
The project is fully relocatable: move the whole folder (including `.git`).
It's a local-only repo with no remote and no absolute paths in the app code.
Note that Claude Code session history and file-based memory are keyed to the
folder's *path*, so they don't follow a move - which is exactly why this file
exists: durable context lives in the repo, not in a chat session.
