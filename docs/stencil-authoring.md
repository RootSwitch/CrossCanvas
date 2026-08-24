# Drawing a CrossCanvas stencil

How to make a device icon that looks like the bundled set and behaves like it -
recolors with Device Color, stays small, and survives a theme change. Written
for a person with a vector editor, but everything here is checkable in a text
editor too, because a stencil is a few hundred characters of coordinates.

The bundled set is 55 stencils in `devices.js`. Median size is about 1.5 KB.
If your finished file is much bigger than that, something below explains why.

---

## What a stencil actually is

A `devices.js` entry, and nothing else:

```js
{
    "name":  "Switch",
    "category":  "Network",
    "image":  "data:image/svg+xml;base64,PHN2ZyB3aWR0aD0i..."
}
```

The `image` is your SVG, base64-encoded into a data URI. The app renders it
with `<image href="...">` sized to the device box, so the SVG is scaled as a
unit and never reflowed. Anything a browser can draw inside `<image>` works;
anything it cannot (external references, scripts) silently does not.

`category` must be one of `Network`, `Endpoints`, `Servers & Storage`,
`Security`, `OT / IoT`, `Telecom`, `Places & People`, `General`. Anything else
sorts under `Imported`, and a missing category on a bundled stencil sorts under
`Other`.

---

## The canvas: 300 x 300, glyph only

Use `viewBox="0 0 300 300"`. Every bundled stencil does, and the app scales
that box to whatever size the device is on the diagram.

**Do not draw the frame.** The white rounded rectangle with the blue border is
painted by the app at render time, not baked into the art:

- stroke width `16/300` of the device's smaller side
- corner radius `30/300`
- face `rgb(255,254,254)`, stroke `rgb(45,103,185)` or the device's tint

That is why the bundled icons are borderless glyphs. Baking your own frame in
means two frames, and yours will not stretch or recolor with the device.

**Keep the artwork inside roughly x/y 40 to 260.** That is where the existing
set lives (Firewall spans 50 to 250, Server 100 to 200) and it clears the
painted frame with room to spare. Art that runs to the edges collides with the
border stroke.

---

## The one rule that matters: a single flat color

This is the rule that decides whether Device Color works on your stencil, and
it is not obvious from looking at the app.

Every fill and stroke is classified by one test (`isChromatic` in `app.js`):

```
luminance between 25 and 230, AND (max channel - min channel) > 30
```

Roughly: "does this color have real hue." What follows from it:

- **Draw the whole glyph in one flat color and it recolors.** Pure black works
  (it gets normalized to the house blue on import). A single saturated color
  works (it gets tinted directly). Either is fine, so pick whichever is easier
  to see while you draw.
- **Gray shading is the trap.** Grays fail the chromatic test, so tinting skips
  them. You get a correctly tinted silhouette with dead gray shading welded on
  top, which reads as "Device Color is broken" and is really "the shading was
  never a color the app was willing to touch."
- **Multiple hues collapse.** A multicolored icon is left alone on import, but
  the moment somebody tints it, every hue becomes the same one. If the art only
  makes sense in several colors, accept that it is a fixed-color stencil.

So: no gradients, no drop shadows, no soft shading, no highlight-and-lowlight.
One color, flat. That happens to be the house style anyway, which is not a
coincidence - the style and the recoloring rule grew up together.

---

## Do not trace a bitmap

The most tempting shortcut is the one that produces the worst file. Two
stencils from the bundled set, both real:

| stencil | size | paths | longest `d` attribute |
|---|---|---|---|
| Switch | 1,607 bytes | 4 | 147 characters |
| Cloud | 104,939 bytes | 4 | **51,121 characters** |

Same path count, 65x the bytes. Cloud was auto-traced from a raster, so a curve
that three `C` commands would draw exactly is instead thousands of micro
segments. It renders fine and it is parsed and rasterized on every draw, on
every device using it, forever.

If you have a drawing you like as pixels, redraw it as geometry rather than
tracing it. For the flat linework this set uses, that is usually faster than
cleaning up a trace anyway.

---

## Editors

- **Inkscape** - free, and SVG is its native save format rather than an export.
  The right choice if you do not already own something.
- **Affinity Designer** - what most of the bundled set was drawn in (43 of the
  55 still carry its `xmlns:serif="http://www.serif.com/"` namespace). Those
  are the filled-silhouette stencils.
- **A text editor** - not a joke for this style. The Switch glyph is four paths
  of about 150 characters. `M` (move), `L` (line), `C` (curve) is the whole
  vocabulary for flat icons, and hand-written paths never surprise you.

**Not GIMP** (raster: it can only export a trace) and **not Blender** (3D
modeler, wrong problem entirely).

If you use Inkscape, export with **Save As > Optimized SVG**, turn on "shorten
color values", and set coordinate precision to about 3 decimals. A plain
Inkscape save embeds `sodipodi:` and `inkscape:` editor metadata that can
double the file and means nothing to a browser.

---

## The quickest path: wrap an existing icon

Twelve of the 55 were not drawn from scratch at all. They are
[Tabler](https://tabler.io/icons) line icons dropped into a fixed wrapper, and
if a suitable icon already exists under a permissive license this is minutes
of work instead of an afternoon.

Tabler icons are 24 x 24 stroke art. The wrapper scales one into the house box:

```xml
<svg width="100%" height="100%" viewBox="0 0 300 300" xmlns="http://www.w3.org/2000/svg">
  <g transform="translate(30,30) scale(10)"
     fill="none" stroke="rgb(45,103,185)" stroke-width="2.5"
     stroke-linecap="round" stroke-linejoin="round">
    <!-- the icon's <path> elements, verbatim -->
  </g>
</svg>
```

Every number in that is doing a job: `scale(10)` takes 24 units to 240,
`translate(30,30)` centers that in 300 with a 30-unit margin, and
`stroke-width="2.5"` in icon space lands at 25 units at full size, which is
what makes a wrapped icon read at the same visual weight as a drawn one. The
stroke color is the house blue, so tinting works exactly as it does for the
filled stencils.

Sensor is 421 bytes and PLC is 556 - the smallest real stencils in the set.

So there are two idioms here, filled silhouettes and stroke line art, and both
are correct. Match whichever your neighbors in the category use.

---

## Adding it

Two ways, and the first is better while you iterate:

**Import Device Library** in the sidebar takes a `.js` or `.json` file in the
same shape as `devices.js`. Nothing to rebuild, and you can see your stencil on
a real diagram, tint it, and check it against a few themes before committing to
anything.

**Editing `devices.js`** is the permanent form: add the entry, keep the file
alphabetical, and give it a category. If you are replacing an existing stencil
or renaming one, keep the old name working as an alias - saved diagrams
reference stencils by `@name`, so a rename without an alias silently unicons
every board that used it.

---

## Checking your work

Before it ships, confirm all five:

1. `viewBox="0 0 300 300"`, artwork inside about 40 to 260, no baked frame.
2. One flat color throughout. Search the file for `gradient`, `filter` and
   `opacity` and expect zero hits.
3. Size in the neighborhood of the 1.5 KB median. If it is tens of KB, look at
   the longest `d` attribute before anything else.
4. Drop it on a diagram, set Device Color, and watch the whole glyph change. If
   part of it stays gray, that part is shading.
5. Switch themes. The stencil is on the canvas, not the chrome, so it should
   not move at all - if it does, something in it is reading a theme color.
