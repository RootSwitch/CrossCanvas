# CrossCanvas for AI agents

This file is self-contained context for an AI assistant (Claude Code, Cline,
Copilot, a local model, anything) that you want to generate CrossCanvas
diagrams for you. Hand the agent **this one file** plus your inventory data -
it does not need to read the application source, and pointing it at the whole
repo mostly burns tokens on rendering code it will never use.

The division of labor that works: **the agent writes data, the app does the
drawing.** Models are good at classifying devices, naming things, and deciding
what belongs in which zone; they are bad at pixel geometry. CrossCanvas
already has deterministic import, zone building, and auto-layout - so the
highest-quality pipeline is usually the agent emitting a small CSV and the app
doing the rest. Direct `.xcanvas` authoring is also supported (and documented
below) for when the agent should control exact placement and connections.

Two paths, in order of preference:

| Path | Agent emits | App contributes | Use when |
|---|---|---|---|
| A: Inventory CSV | a ~10-column CSV | stencil match, zone nesting, layout | most cases: "turn this inventory/scan/export into a diagram" |
| B: `.xcanvas` JSON | the full diagram file | validation, rendering | exact positions, connections, annotations, live-dashboard boards |

---

## Path A: inventory CSV (recommended)

Emit a CSV with this header (column order does not matter; only `label` or
`Hostname` is truly required, everything else is optional):

```csv
label,stencil,Hostname,IP-Address,Serial-Number,Asset-Tag,Description,Location,Firmware
Core-SW-01,switch,core-sw-01,10.0.0.2,FDO2419A1B,AST-0001,Primary core switch,HQ / Floor 1 / MDF,17.9.4a
Edge-FW,firewall,edge-fw-01,10.0.0.1,FGT60F0001,AST-0003,Perimeter firewall,HQ / Floor 1 / MDF,7.2.8
AP-Lobby,access point,,10.0.10.11,KWC2234001,AST-0010,Ceiling access point,HQ / Floor 1,
File-Server,server,files,10.0.20.5,SGH123XYZ,AST-0020,SMB file server,HQ / Floor 2,
```

Rules:

- **`label`** - the text under the icon. Keep it short; the hostname's first
  segment is a good default. Falls back to `Hostname` if blank.
- **`stencil`** - a name from the stencil list at the end of this file,
  case-insensitive, common aliases accepted (`access point` matches WifiAP).
  Leave blank when unsure - blank gets a neutral placeholder the user can fix
  in two clicks, which beats a confidently wrong icon.
- **`Location`** - drives zones. `HQ / Floor 1 / MDF` produces a nested
  zone hierarchy (HQ containing Floor 1 containing MDF) with the devices laid
  out inside the innermost zone. Devices sharing a Location land together.
  This column is where an agent adds the most value: assign sensible
  locations and the diagram organizes itself.
- **Any extra column** (`Firmware` above) becomes a custom field on the
  device - visible in the device panel, exported with the diagram.
- The user imports the file via **File > Import** in the app; format
  detection is automatic. Layout is deterministic: same CSV, same diagram.

The app also auto-detects many vendor exports directly (Cisco ISE, Windows
DNS zone exports, nmap output, ARP tables, dnsmasq/DHCP leases, Ansible INI
inventories, and a column-mapper for everything else), so if the source data
IS one of those, hand it over unmodified instead of transcribing it.

### Fields with monitoring meaning

CrossCanvas is the editor for a monitoring suite (PingCanvas renders boards as
a live wall). These device fields are contracts, not decoration:

| Field | Meaning |
|---|---|
| `IP-Address` | Device becomes monitorable; the poller pings it. One field = live up/down on the wall. |
| `Hostname` | Display name in monitoring feeds. |
| `Check` | `icmp` (default) or `tcp`. |
| `Port` | TCP port, when `Check` is `tcp`. |
| `Monitor ID` | Optional explicit feed key. Two board entries watching the same IP need distinct Monitor IDs to be tracked separately; the same Monitor ID on two boards shares one status entry. |

---

## Path B: hand-authored `.xcanvas`

An `.xcanvas` file is plain JSON. The loader is deliberately forgiving:
`spans`/`lineFormats` rich-text structures are derived from plain `label`
strings, arrow fields default to `none`, ids are remapped on load (they only
need to be **internally consistent**, any unique strings work). A minimal
valid file:

```json
{
  "version": 6,
  "diagramTitle": "tiny-example",
  "devices": [
    {
      "id": "dev1", "image": "@Switch", "originalImage": "@Switch",
      "x": 300, "y": 120, "w": 60, "h": 60,
      "label": "core-sw-01", "labelPosition": "bottom",
      "fontSize": 14, "fontColor": "#333333",
      "fields": { "Hostname": "core-sw-01", "IP-Address": "10.0.0.2" },
      "attachmentPoints": [
        {"rx":0,"ry":0},{"rx":30,"ry":0},{"rx":60,"ry":0},{"rx":60,"ry":30},
        {"rx":60,"ry":60},{"rx":30,"ry":60},{"rx":0,"ry":60},{"rx":0,"ry":30}
      ]
    },
    {
      "id": "dev2", "image": "@Server", "originalImage": "@Server",
      "x": 300, "y": 300, "w": 60, "h": 60,
      "label": "files\n10.0.20.5", "labelPosition": "bottom",
      "fontSize": 14, "fontColor": "#333333",
      "fields": { "Hostname": "files", "IP-Address": "10.0.20.5" },
      "attachmentPoints": [
        {"rx":0,"ry":0},{"rx":30,"ry":0},{"rx":60,"ry":0},{"rx":60,"ry":30},
        {"rx":60,"ry":60},{"rx":30,"ry":60},{"rx":0,"ry":60},{"rx":0,"ry":30}
      ]
    }
  ],
  "connections": [
    {
      "id": "c1", "fromDevice": "dev1", "fromAP": 5, "toDevice": "dev2", "toAP": 1,
      "color": "#333333", "thickness": 2, "dash": "solid", "routing": "rounded",
      "label": "", "startArrow": "none", "endArrow": "none", "annotations": []
    }
  ],
  "zones": [
    {
      "id": "z1", "shape": "rectangle", "x": 240, "y": 60, "w": 220, "h": 340,
      "label": "Server Room", "labelPosition": "top-inside",
      "fontSize": 15, "fontColor": "#2d67b9",
      "fill": "#e8f4fd", "borderColor": "#2d67b9", "opacity": 1,
      "attachmentPoints": []
    }
  ],
  "textBoxes": [],
  "images": [],
  "groups": [],
  "deviceTemplates": [],
  "imageTable": {},
  "nextId": 100
}
```

### Object reference

**Device** - `x`/`y` is the icon's top-left corner; standard size is
`w: 60, h: 60`. `image: "@<Stencil Name>"` references a bundled stencil by
exact name from the list below (set `originalImage` to the same value; never
embed image data). Multi-line labels use `\n`. `labelPosition`:
`top | bottom | left | right | center`. `fields` is a flat string map -
the monitoring fields above plus anything else worth recording.
**`attachmentPoints` are required**: for a `w` x `h` device, emit the 8-point
perimeter array shown above (corners and edge midpoints, clockwise from
top-left, coordinates relative to the icon). Index map, used by connections:

```
0 = top-left    1 = top-center    2 = top-right    3 = right-center
4 = bottom-right  5 = bottom-center  6 = bottom-left  7 = left-center
```

**Connection** - `fromDevice`/`toDevice` are device ids; `fromAP`/`toAP` are
attachment-point indices (downlinks: bottom of the upper device, `5`, to top
of the lower device, `1`). `routing`: `straight | orthogonal | rounded`
(rounded = orthogonal with soft corners; use it as the default). `dash`:
`solid | dash-sm | dash-md | dash-lg | dash-dot | dot`. `startArrow`/`endArrow`:
`none | arrow | open-arrow | circle | diamond`. `annotations` is a list of
`{ "id": "a1", "text": "...", "position": 0.5 }` - text pinned along the line
(`position` 0..1 from the `from` end); network diagrams use these for
interface names.

**Zone** - a labeled container drawn behind devices. `shape`:
`rectangle | ellipse | diamond | parallelogram | pill | document | cylinder`.
`labelPosition` adds `top-inside | bottom-inside`. Nesting is purely spatial:
a zone whose rectangle contains another becomes its parent (parents
auto-render as a lighter tint, so nested zones stay readable). Give zones
30-40 px padding around their contents and never let sibling zones overlap.

**Text box** - `{ "id", "x", "y", "text", "fontSize", "fontColor",
"textAlign" }`. Use for titles and legends.

### Live-dashboard bindings (the suite contract)

Boards render as live walls in PingCanvas, with data from SNMPCanvas. Three
bindings turn a drawing into a dashboard:

- A device with an `IP-Address` field gets a live up/down status glow.
- A label line (device label, text box, or zone label) containing a
  `{CODE}` token - e.g. `CPU: {C3}` - shows that metric's live value. Codes
  come from SNMPCanvas's Watching page; unknown codes stay literal.
- A connection annotation whose text is an interface id (`Device:ifName`,
  e.g. `core-sw-01:GigabitEthernet0/1`) or an interface code becomes a live
  throughput pill with link up/down coloring.

When generating a board for someone's monitoring wall, leave `{CODE}` tokens
out unless you were given the codes - a literal `{C3}` on screen is a typo,
not a feature.

### Layout conventions that read well

- Vertical tiers, top down: WAN/internet, edge (firewall/router), core,
  distribution/access, then endpoints and servers.
- Grid-align: 60 px icons on ~140-160 px horizontal centers, 120-180 px
  between tiers. Round every coordinate to a multiple of 10.
- Minimize crossings: place a device near what it connects to; when a device
  uplinks to two peers, center it between them.
- A dozen devices per zone is comfortable; past that, split into more zones
  rather than shrinking spacing.
- Symmetry beats compactness. Two redundant cores side by side at the same
  `y`, uplinks mirrored.

### Validating output

Open the file in CrossCanvas (File > Open). The loader validates shape before
touching the canvas and reports what it rejected; a malformed file never
destroys existing work. If it renders, it round-trips - Save produces a
normalized version of the same diagram. The fastest iteration loop is:
generate, open, screenshot, adjust coordinates, repeat.

---

## Bundled stencil names

Reference as `"@<name>"` in `.xcanvas` (exact, case-sensitive there) or in
the CSV `stencil` column (case-insensitive, aliases tolerated).

- **Network**: Cloud, Cloud Router, EthernetRJ45, Firewall, Globe,
  Interconnect, Link, LoadBalancer, Modem, Multilayer Switch, Patch Panel,
  Router, Switch, VRF, WifiAP, Wireless Controller
- **Servers & Storage**: LDAP, NAS, Rack, Server, ServerCluster, Storage,
  UPS, VM
- **Endpoints**: Analog Phone, Camera, Client, ClientVM, Laptop,
  Mobile Phone, Printer, Tablet, VOIPPhone
- **OT / IoT**: Badge Reader, PLC, Sensor
- **Security**: Bug, Fingerprint, Inspect, Shield
- **Telecom**: Cloud Phone, Satellite, Satellite Dish
- **Places & People**: Factory, House, Map Pin, Office, User
- **General**: Cog, Communications, Grid, Light Bulb, Statistics, XML
- **Special**: Blank (invisible node - an anchor for connections)

Common mappings: L2/access switch -> Switch; L3/core -> Multilayer Switch;
hypervisor host -> Server; guest VM -> VM; NAS/SAN -> NAS or Storage;
wireless AP -> WifiAP; internet/ISP -> Cloud; workstation -> Client;
virtual desktop -> ClientVM.
