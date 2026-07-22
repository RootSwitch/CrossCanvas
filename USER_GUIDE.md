# CrossCanvas - User Guide

CrossCanvas is a browser-based editor for network and application diagrams. It runs
entirely on your machine with no sign-in and no internet connection. This guide
walks through everything from placing your first device to exporting a finished
diagram.

---

## Contents

1. [The workspace](#the-workspace)
2. [Building a diagram](#building-a-diagram)
3. [Devices & stencils](#devices--stencils)
4. [Zones](#zones)
5. [Connections](#connections)
6. [Text & labels](#text--labels)
7. [Device data fields](#device-data-fields)
8. [Live monitoring overlays](#live-monitoring-overlays)
9. [Arranging & aligning](#arranging--aligning)
10. [Styling & themes](#styling--themes)
11. [Saving & opening](#saving--opening)
12. [Importing diagrams](#importing-diagrams)
13. [Exporting](#exporting)
14. [Inventory import](#inventory-import)
15. [Keyboard shortcuts](#keyboard-shortcuts)

---

## The workspace

- **Menu bar** (top) - File, Export, Edit, Layers, Align, Bulk Actions, Help, plus
  the theme picker and dark-mode toggle on the right.
- **Toolbar** - select, connect, text, pan, zoom, undo/redo, copy/paste,
  delete, arrange (z-order), grid and snap toggles.
- **Left sidebar** - collapsible sections: **Default Settings**, **Zones /
  Text** (background shapes + the text-box tool), **Devices** (the stencil
  palette + search), and **Device Library** (import/export tools).
- **Canvas** - the drawing surface. It auto-expands as you approach the edges;
  scrollbars appear only when content exceeds the view.
- **Properties panel** - appears when an object is selected. The menu-bar
  button cycles three modes: **Properties: Right** (opens on selection),
  **Right (Locked)** (the pane stays open permanently, so selecting an object
  never reflows the canvas under your cursor), and **Left** (docked at the
  bottom of the left sidebar).

---

## Building a diagram

The fastest way to start:

1. **Drag a stencil** from the Devices palette onto the canvas.
2. **Connect two devices** - switch to the Connect tool (or hover a device edge)
   and drag from one attachment point to another. The line snaps to the nearest
   attachment point when you release.
3. **Add a zone** - drag a shape from the Zones / Text section to group or
   label an area; it sits behind your devices.
4. **Label things** - double-click any device, zone, or connection to edit its
   label inline.

Everything is undoable (`Ctrl+Z`), and objects snap to the grid. Hold **Alt**
while moving or resizing for half-grid (5px) precision - pressing Alt *after*
the drag starts works too (handy in Firefox, where a lone Alt tap opens the
menu bar).

---

## Devices & stencils

- **Place** a device by dragging it from the palette; **search** narrows the
  list. Search matches each stencil's name *and* a set of common synonyms, so
  you don't have to know the exact stencil name - "pc" or "computer" find
  *Client*, "phone" finds *VOIPPhone*, and "wifi" or "access point" find
  *WifiAP* (scanner → *Printer*, cctv → *Camera*, and so on). Exact-name
  matches are listed first.
- **Categories** group the palette (Network, Endpoints, Servers & Storage,
  Security, OT / IoT, Telecom, Places & People, General; your own imports
  appear under Imported). Click a category header to collapse it - the choice is
  remembered. Search ignores the grouping and always matches every stencil.
  The Icon dropdowns group the same way.
- **Select** a device to open Device Properties, where you can change its label,
  font, size, **Device Color** (a tint applied to the icon), **Device
  Background** (the face color inside the frame), and attachment-point count.
- **Swap the icon** with the **Icon** dropdown - useful after an import leaves a
  device as the generic **Blank** stencil.
- **Resize freely** - drag the handles to make non-square devices, or type exact
  **W × H** values. The `×` buttons scale proportionally, and holding **Shift**
  on the corner handle keeps the W:H ratio while dragging (squares stay square).
- **Add your own icons** - under **Device Library → Import Device Image / SVG**.
  Monochrome SVGs (e.g. from icon sets like Lucide or Tabler) are recolored to
  match the bundled set and stay recolorable via Device Color.
- **Share a stencil set** - **Export Device Library** writes a
  `customdevices.js` you can drop next to `index.html` on another install;
  **Import Device Library** reads one back.

---

## Zones

Zones are labeled background regions (VLANs, buildings, trust boundaries, and so
on). Drag a shape from the **Zones** section - rectangle, ellipse, diamond,
parallelogram, pill, document, or cylinder.

In Zone Properties you can set the **Fill**, **Border Color**, **Opacity**, and
the label's position (including inside-top or centered). Zones always render
behind devices, so devices placed inside a zone stay on top.

---

## Connections

- **Draw** by dragging from a device's edge (or attachment point) to another
  device. Drop on empty canvas to leave a free-floating endpoint.
- **Routing** - choose Straight, Rounded, or Orthogonal per connection.
- **Reshape** - selected connections show drag handles: **bend handles** on
  auto-routed segments, or **waypoint handles** on imported hand-routed paths.
  Drag them to reroute; a bend dropped back on its natural line removes itself.
- **Re-attach** - drag an endpoint to a different attachment point or device.
  Endpoints stay glued to their device as you move it.
- **Style** - set color, thickness, dash pattern, and independent start/end
  arrowheads (arrow, open arrow, diamond, circle).
- **Label & annotate** - add a label, or double-click anywhere along the line to
  drop a draggable inline annotation.

Adjust a device's **Attachment Points** count in its properties to control how
many connection anchor points it offers.

---

## Text & labels

- **Text boxes** - click the **T** toolbar button, then click the canvas to drop
  a ready-to-type text box (press **Esc** to cancel).
- **Rich formatting** - labels and text boxes support multiple lines, per-line
  and per-character **bold** / *italic*, and even **per-character color**.
- **Fonts** - pick from curated system font families; set size and color.
- **Alignment** - horizontal (left/center/right) and, for multi-line labels,
  vertical (top/center/bottom). Label position (top, bottom, left, right,
  inside) is set per object.

---

## Device data fields

Every device has a collapsible **Device Details** section in its properties
panel for free-form inventory data:

- Standing fields: **Hostname, IP-Address, Serial-Number, Asset-Tag,
  Description, Location** - plus any custom field you add.
- **Hostname** falls back to the device's label if left blank.
- The data is saved with the diagram and included in **CSV export** (one column
  per field).

This makes a diagram double as lightweight inventory, and pairs with **Inventory
CSV import** below.

---

## Live monitoring overlays

A CrossCanvas board is also the display layer for its sibling apps: **PingCanvas**
renders your diagram as a live wall, and **SNMPCanvas** feeds it device metrics.
Two things you author *here* light that up - and neither needs those apps installed
to draw the board, since both are just data until a wall renders them.

- **Reachability.** Give a device an **IP-Address** and PingCanvas polls it,
  ringing the device green / amber / red by status. A device with no IP-Address
  simply renders as a plain fixture with no ring - so a UPS or an internet cloud
  you drew for context is not flagged as unmonitored.
- **Live values with `{code}` tokens.** Put a token like `{CPU1}` in a device
  **label line** or a **connection annotation**, and on the wall it is replaced
  by that metric's live reading - `CPU 45%`, a link's inbound/outbound bandwidth,
  a temperature, and so on. SNMPCanvas mints these codes and offers a copy-ready
  `{code}` chip for each value; paste it straight onto a label or annotation. Text
  around a token is kept (`Rx {K7Q2}`), several per line work (`{IN} / {OUT}`), and
  an unmatched token stays literal so a typo shows rather than silently vanishing.

See the PingCanvas and SNMPCanvas guides for the poller and metric-feed setup.

---

## Arranging & aligning

- **Alignment guides** appear as you drag, snapping objects to each other's
  edges and centers. Toggle them from the toolbar; hold **Alt** to bypass.
- **Align menu** - align or evenly distribute a multi-selection.
- **Arrange (z-order)** - bring to front / send to back / step forward / backward
  from the toolbar, Layers menu, or right-click menu. Devices and text boxes
  interleave in a shared layer.
- **Layers menu** - show/hide or lock each canvas *tier* (Zones, Connections,
  Images, Devices & Text). Locking Zones, for example, lets you rubber-band the
  devices inside a zone without grabbing the zone itself. Tier state is
  view-only and not saved with the file.

---

## Styling & themes

- **Default Settings** (top of the sidebar) sets the colors new objects get:
  font, **Device Color**, **Device Background**, **Zone Color**, **Zone Border
  Color**, and default attachment-point count. Each has a **Reset** that
  restores the active theme's value.
- **Themes** - the picker by the dark-mode toggle offers 29 looks, grouped
  (Paper, Warm, Cool, Night, Screen). **Classic** - the untinted original - is
  the default; beside it sit a material family inspired by the canvas name -
  **Canvas** (raw-canvas ecru), Gesso (warm-white minimal), Blueprint (cyanotype
  drafting), Ink (india-ink dark) - plus warm (Garnet, Ember, Rose, Sakura,
  Retro), cool (Sage, Evergreen, Lagoon, Glacier, Slate, Storm, Arctic, Solar
  Light), night (Midnight, Crimson Navy, Synthwave, Nocturne, Tokyo Night, Solar
  Dark) and terminal (Phosphor, Amber) palettes. A theme recolors the app
  chrome *and* seeds the default object colors - device tint, zone fill/border,
  and now the **label font color**. Existing objects are left untouched; an
  **imported inventory**, however, is built with the active theme (device
  tint, zone fill/border, and themed zone/device label colors), so it needs no
  post-import recolor. (Imported *diagrams* still keep their source styling.)
- **Recolor All to Theme** (Bulk Actions menu) retroactively snaps every existing
  device and zone to the current theme's colors - handy after an import. It's
  undoable.
- **Map Details to Label** (Bulk Actions menu) stacks chosen Device Details into
  every device's label, one field per line - Hostname + IP-Address by default.
  Handy after an inventory import to surface the IP on the canvas. Undoable.
  Hostname + IP (two lines) fits the import layout cleanly; three or more lines
  start to clip into the row below.
- **Dark mode** - toggle top-right. It's surface-aware: labels and lines flip to
  stay legible against whatever's behind them, and each theme carries its own
  dark shade.

---

## Saving & opening

- **File → Save** writes a `.xcanvas` file (plain JSON). The diagram title drives
  the filename and the version number auto-increments.
- **File → Save with Embedded Images** produces a self-contained file that opens
  with full icons on any CrossCanvas install, regardless of its stencil library.
- **File → Open / Import Diagram** loads `.xcanvas` (and legacy `.json`) files; **Open Recent**
  lists the last diagrams you saved or opened, with a **Clear Recent** entry.
- **Autosave** keeps your work in the browser and offers to restore it on the
  next launch.

---

## Importing diagrams

**File → Open / Import Diagram** also accepts Gliffy and Visio files:

- **Gliffy (`.gliffy`)** - devices keep their original dimensions and exact
  connection anchors; hand-routed lines, dashes, fonts, label positions, and
  per-color legends are preserved.
- **Visio (`.vsdx` / `.vsdm`)** - unzipped and parsed entirely in the browser
  (no dependencies). Device icons map to the bundled stencils, container shapes
  become zones (with their source colors), connector routes and arrowheads are
  imported, and embedded images come across as pasted images. Multi-page files
  prompt you to pick a page.
- **draw.io (`.drawio`)** - both diagrams.net save styles (compressed and
  uncompressed mxGraph XML; `.xml` saves are detected by content). Exact
  connection anchors and waypoints are preserved, containers and plain
  rectangles become zones, and stencil shapes map to the bundled device set.
  CrossCanvas's own draw.io exports **round-trip**: device icons, colors, and
  Device Details all come back intact. Multi-page files prompt for a page.

Unrecognized icons import as the generic **Blank** stencil, which you can swap
via the Icon dropdown; the import summary lists what needs attention.

**Your own stencils outrank the bundled set.** If a stencil you added through
the Device Library (or a team `customdevices.js` layer) has a name matching an
incoming shape - say you imported your own `Cisco Switch` icon and the Visio
file is full of switch shapes - imports resolve to *your* icon first. Name
your custom stencils after the shapes you want them to capture.

### Merging diagrams

**File → Import & Merge…** adds a diagram to the current canvas instead of
replacing it. The incoming content lands to the right of what's already there,
every object gets fresh internal ids (so nothing collides, even when merging
two `.xcanvas` files), and the canvas keeps its own title and version. Merge
as many files as you like, in any mix of formats - a Visio site plan next to a
Gliffy rack next to a native board - then rearrange and connect them into one
diagram. A single **undo** removes the last merge.

### Batch conversion

**File → Convert Diagrams…** converts a whole multi-selection of `.gliffy` and
`.drawio` files (draw.io `.xml` saves too) to `.xcanvas` in one pass - each file
runs through the same importer as a hand import, so the fidelity is identical.
Each `name.gliffy` / `name.drawio` becomes `name.xcanvas`; multi-page draw.io
files convert their busiest page (the roll-up says which). On Chrome/Edge you
pick an output folder and the files are written straight into it; on other
browsers each file arrives as a download.
A prompt asks whether to **keep each file's source colors** (imports normally
preserve the original styling) or **recolor everything to the current theme** -
the batch equivalent of running Bulk Actions → Recolor All to Theme on each
converted diagram, handy for unifying an old Gliffy archive into your palette.
The canvas acts as the conversion workbench (you'll see each diagram flash by),
the last converted diagram stays loaded for spot-checking, and the final
roll-up lists per-file object counts plus anything that failed.

---

## Exporting

From the **Export** menu:

- **Images** - PNG, JPEG, or PDF, each available **with or without the grid**.
  A dedicated **PNG (Transparent)** option omits the white background so the
  diagram can be laid over any surface. **Image Scale** (bottom of the Export
  menu, persisted) renders raster exports at 1× / 2× / 4× - use 2× or 4× for
  print, video, or anything viewers will zoom into; PDFs keep their page size
  and gain DPI. SVG and CSV are unaffected (vector/data).
- **SVG** - a scalable vector file that opens in browsers and Visio.
- **draw.io** - an `.drawio` file that opens directly in diagrams.net (which can
  itself re-export to Visio). Device Details ride along as draw.io shape data.
  Rather not open a sensitive diagram in a web app? The open-source
  **draw.io Desktop** app (github.com/jgraph/drawio-desktop) opens the same
  file and exports Visio `.vsdx` entirely offline.
- **CSV (data)** - one row per object, with human-readable columns (type, label,
  device fields, connection endpoints by name) first and geometry/styling after.

Hidden layers export as displayed; locked layers export normally.

---

## Inventory import

**File → Import Inventory** turns a device inventory into a laid-out starting
diagram, ready for manual arrangement (it does not draw connections). Vendor
CSVs, DHCP lease files, and pasted command output are all detected
automatically; any other CSV opens the **column mapper** (below).

**File → Paste Inventory** is the same importer without a file: paste a cell
range copied straight out of Excel, LibreOffice, or Google Sheets
(tab-separated paste is understood), CSV text, or any of the accepted command
dumps. Untick *First row is headers* if you copied data without its header row.

**Help → Inventory Import Formats** documents everything in-app and offers a
**Download example CSV** button (a ready-to-fill `crosscanvas-inventory-template.csv`).

The CSV needs a header row; column names are case-insensitive:

| Column | Purpose |
|--------|---------|
| `label` | Device label (falls back to `Hostname`) - the only near-required field |
| `stencil` | Icon name (fuzzy-matched; unknown → Blank) |
| `Hostname`, `IP-Address`, `Serial-Number`, `Asset-Tag`, `Description`, `Location` | The standing device data fields |
| `x`, `y` | Optional exact placement (skips auto-layout) |
| *(any other column)* | Becomes a custom data field named by its header |

**`Location` drives grouping.** A `/`- or `|`-delimited path nests devices into
zones - e.g. `HQ / Floor 1 / MDF` places the device three zones deep. Devices
with no `Location` land in a loose grid. Layout expands in a balanced,
widescreen shape.

**The column mapper.** A CSV whose headers match neither the template nor a
vendor signature opens a mapping step instead of failing: over a preview of
your data, assign each column (Label, Location, IP Address, ...) or leave it as
a custom field - only Label (or Hostname) is required. A confirmed mapping is
remembered for files with the same headers, so the next export from the same
tool imports in one click.

**Sort.** *Import Sort* in **Default Settings** orders the devices within each
zone: File order (CSV order), *Device type* (groups cameras/printers/PCs), *MAC
address* (groups by vendor), or *Label*. A synthetic switch/WLC sorts to the top
of its zone.

**Spacing.** Two sliders in **Default Settings** - *Import Spacing - Wider* and
*- Taller* (100-250%) - spread the imported grid horizontally and vertically.
Widen for long hostnames that would otherwise clip into neighbors; heighten to
make room for multi-line labels (e.g. after **Map Details to Label**). They
apply to the next import; leave both at 100% for the default packing.

### Auto-detected vendor formats

Several management-platform exports are recognized by their column
signatures and imported **as-is** - no manual column cleanup needed. A curated
subset of columns maps to Device Details; the rest (a Catalyst Center export
has ~55 columns, ISE 100+) are dropped to keep the details panel useful.

**Cisco Catalyst Center inventory** (detected by *Device Name* + *Device
Family* + *Reachability*):

| Catalyst Center column | Becomes |
|---|---|
| Device Name | Label + Hostname |
| IP Address / Serial Number | IP-Address / Serial-Number |
| Platform | Description |
| Site | Location (the constant `Global/` root is stripped) |
| MAC Address, Device Role, Image Version | Custom fields |
| Device Family (+ Device Role) | Stencil (switch, router, AP, firewall…) |

**Cisco ISE endpoints** (detected by *MACAddress* + *EndPointPolicy*):

| ISE column | Becomes |
|---|---|
| host-name (falls back to MACAddress) | Label (domain stripped) + Hostname (full FQDN kept) |
| ip / Description | IP-Address / Description |
| EA-cmdbAssetTag / EA-cmdbSerialNumber | Asset-Tag / Serial-Number |
| Location | Location (`#`-hierarchy roots stripped, nested as zones) |
| MACAddress, EndPointPolicy, operating-system | Custom fields (MAC Address, Endpoint Policy, OS) |
| EndPointPolicy keywords | Stencil (printer, camera, phone, laptop, client…) |

Endpoints whose profiler policy doesn't match a stencil import as Blank
without cluttering the summary - swap icons later if you care about them.

**NetBox devices** (detected by *Name* + *Site* + *Role* + *Manufacturer* +
*Rack*/*Location*) - the stock Devices-list export, either the default
columns or **All Data**:

| NetBox column | Becomes |
|---|---|
| Name | Label (domain stripped) + Hostname |
| IP Address (or IPv4 Address) | IP-Address (the `/24` prefix length is stripped) |
| Manufacturer + Type | Description (e.g. `Cisco C9300-48P`) |
| Serial / Asset Tag (All Data) | Serial-Number / Asset-Tag |
| Role | Custom field (Device Role) + stencil keywords |
| Site / Location / Rack | Location path - the DCIM hierarchy nests as zones |

Role and Type names pick the stencil (switch, router, firewall, AP, wireless
controller, server, storage, patch panel, UPS/PDU, camera, modem…). Nautobot
2.x exports a different column dialect and is *not* detected - use NetBox-style
headers or the plain format if importing from Nautobot.

Like the Catalyst Center wired-client export, an ISE export on its own **groups
clients under their network device**: each client nests in a zone named for the
switch/WLC it authenticated through (`NetworkDeviceName` + `NADAddress` for its
IP). NADs that look like controllers (`wlc`/`9800`) get the WifiAP icon. ISE
wraps field values in single quotes - those are stripped automatically.

Reverse-lookup FQDNs are trimmed to the short hostname for the on-canvas
label (`finance-pc-042.corp.example.com` → `finance-pc-042`), while the full
name is retained in the Hostname field. IP addresses that land in the
hostname slot are left intact.

**Cisco Catalyst Center wired clients** (detected by *Switch IP Address* +
*Endpoint Type*):

| Wired-client column | Becomes |
|---|---|
| Hostname (falls back to MAC) | Label (domain stripped) + Hostname |
| IPv4 Address | IP-Address |
| MAC Address, OS, Device Type, Port, VLAN ID, Security Group (Tag) | Custom fields |
| Device / Endpoint Type | Stencil (printer, camera, phone, client…) |
| **Switch / Switch IP Address** | Group the client under its switch (see below) |

This one is special: it **groups clients under their switch from a single
file** - the same switch-zone layout as the hybrid, but without needing a
device export or reconciling ISE and Catalyst Center's differing Location
syntaxes. Each unique switch becomes a synthetic Switch device inside a zone
named for it (carrying its Switch IP), and its clients nest in that zone. The
switch's Catalyst Center site path supplies the Building/Floor tiers above it
when present; otherwise you get a flat set of switch zones. FQDN and short
switch names for the same switch are merged.

### Hybrid import: Catalyst Center + ISE together

Select **both files at once** in the Import Inventory picker (Ctrl+click) -
one Catalyst Center device export and one ISE endpoint export. Catalyst
Center provides the location tree and the infrastructure; ISE provides the
clients, and each client nests inside a zone named for the switch it
authenticated through (ISE's *NetworkDeviceName* matched against Catalyst
Center's *Device Name* on short hostname). Containment, not topology - no
connections are drawn.

- Switches on the same floor become **sibling zones**, each containing the
  switch and its connected clients.
- A switch with **no matched clients stays a plain device** - no one-device
  zone clutter.
- **Wireless clients** (ISE reports them against the WLC, not an AP) group
  under their own ISE building in a **Wireless** sub-zone, so they don't
  pile into whatever building the controller lives in.
- Clients whose switch isn't in the Catalyst Center file fall back to plain
  ISE-Location grouping; the summary reports matched/wireless/unmatched
  counts.

Because matched clients inherit their switch's Catalyst Center location,
the ISE Location hierarchy doesn't need to agree with Catalyst Center's -
it's only used for wireless and unmatched clients.

> Tip: the CSV *export* produces columns that re-import cleanly, so you can
> round-trip a diagram through a spreadsheet.

---

## Keyboard shortcuts

| Action | Shortcut |
|--------|----------|
| Undo / Redo | `Ctrl+Z` / `Ctrl+Y` |
| Copy / Paste | `Ctrl+C` / `Ctrl+V` |
| Select all | `Ctrl+A` |
| Duplicate selection | `Ctrl+D` |
| Find on canvas (label / hostname / IP) | `Ctrl+F` - `Enter` / `Shift+Enter` cycle matches |
| Open | `Ctrl+O` |
| Delete selection | `Delete` |
| Multi-select | `Ctrl`/`Cmd`-click (toggle: add or remove), `Shift`-click (add only), or drag a marquee |
| Sub-select one group member | `Ctrl`-click |
| Marquee inside a parent zone | `Alt`+drag starting on the zone (rubber-bands its children instead of moving the zone) |
| Fine (5px) move/resize, bypass guides | hold `Alt` while dragging a device/bend/endpoint |
| Bold / italic in a label editor | `Ctrl+B` / `Ctrl+I` |
| Cancel text placement | `Esc` |
| Open the shortcuts list | `?` |

---

This guide is also available inside the app under **Help → User Guide** (along
with a Quick Start, this shortcuts list, and an About box) - so it travels with
the app wherever it's hosted.

Prefer not to use a hosted copy? **Help → Download Offline Copy** assembles a
zip of the app's own files in your browser - unzip anywhere and open
`index.html` to run CrossCanvas entirely from your machine (no install, no
network). If the host carries a team stencil layer (`customdevices.js`), it
rides along.
