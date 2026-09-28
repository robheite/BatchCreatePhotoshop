# IAWOA CSV Batch Name Creation

`IAWOA Batch Name Creation.jsx` turns one layered Photoshop template and one
header-based CSV into a set of personalized exports. It scans the open PSD every
time, so no layer names are hard-coded into the script.

## Run or install

Download `IAWOA Batch Name Creation.jsx`, then run it with **File > Scripts >
Browse...**.

To make it appear directly in Photoshop's Scripts menu, copy the JSX into the
Photoshop application folder under `Presets/Scripts`, then restart Photoshop.
On a typical Windows installation that folder is:

`C:\Program Files\Adobe\Adobe Photoshop [version]\Presets\Scripts`

Windows normally requires administrator permission for that folder.

This release is tested for desktop Photoshop on Windows. The ExtendScript file
chooser filters use Photoshop's Windows filter syntax; macOS has not been
validated yet.

## Recommended PSD setup

Name editable text layers exactly like the CSV columns. For the South Oldham
file, the useful names are:

- `Team Name`
- `Last Name`
- `Jersey Number`
- `Inmate Number`
- `Charge`
- `Coach Title`
- `Coach Name`

Matching names are mapped automatically. The dialog lets you override any match.

For names or other single-line text that must stay inside a fixed paragraph box,
select the text layer on the **Text mapping** tab and enable **Shrink text to stay
inside its paragraph box**. The font size already used in the PSD is treated as
the maximum, and the script reduces it only when the CSV value is too wide. Set a
minimum font size to prevent unreadably small output. Shorter values return to the
template size on their own row instead of inheriting a prior row's smaller size.
The checkbox and minimum size apply immediately; **Run batch** and **Save mapping**
also commit the currently visible controls, so there is no separate apply step.
For scaled text layers, the script uses Photoshop's effective displayed font size
as the template maximum so short values do not overflow the box vertically.

Auto-fit supports straight, horizontal, unrotated regular paragraph text only.
Rotated, skewed, warped, vertical, and Photoshop Dynamic Text layers are not
supported by this JSX fitting method; convert them to a regular horizontal
paragraph box before mapping or fitting them.

You can also prefix a paragraph text layer with `[fit]` to enable this behavior by
default. For example, `[fit] NAME` can still be mapped manually to `Last Name`.

For design variants, name layer groups with visibility directives:

- `[show:Player Front] PLAYER FRONT`
- `[show:Player Back] PLAYER BACK`
- `[show:Coach Front] COACH FRONT`
- `[show:Coach Back] COACH BACK`

The script treats `yes`, `true`, `1`, `on`, `show`, and `visible` as true. It can
also show a group for an exact value, for example:

`[show:Record Type=Player] PLAYER DESIGN`

Exact-value rules ignore capitalization and outer whitespace, but preserve spaces
and punctuation inside the value.

The directives are only defaults. Every layer and group can be assigned a
visibility rule in the script dialog.

## Workflow

1. Open the layered PSD in Photoshop.
2. Run **File > Scripts > IAWOA Batch Name Creation**.
3. Select a CSV with a header row.
4. Review the automatic text mappings and layer visibility rules.
5. Enable paragraph-box auto-fit for any mapped layer that needs it.
6. Choose an output folder, filename pattern, formats, and existing-file policy.
7. Run the batch. Processing happens in a disposable document duplicate, so the
   original PSD is not edited.

Use **Save mapping...** if you want a reusable `*.mapping.json` preset for a
particular PSD layout. Load it on a later run after the script scans the current document.
Duplicate sibling layer names are numbered in the dialog and saved preset so they
remain distinct; unique names are still recommended for an easier-to-read setup.
Mapping presets are ignored by the repository because their paths and layer names
may be customer-specific.

## Export behavior

The defaults match `IAWOA Batch Export.jsx`:

- full-canvas PNG with maximum PNG compression;
- transparent trimmed PNG with `_trimmed` suffix;
- flattened PDF 1.6 with embedded color profile and maximum JPEG quality;
- optional tiled-watermark JPG proof with `_proof` suffix, 30% dimensions, and
  JPEG quality 3.

The first time watermarked proofs are enabled, the script asks for the watermark
image. That computer's selection is stored under Photoshop's per-user application
data, outside this repository. If the saved image is moved, renamed, or deleted,
the script prompts for its new location and overwrites the saved setting. Each
person therefore selects their own local watermark once; no machine-specific path
is committed to GitHub.

Existing files are not overwritten by default. The preflight stops before any
export unless **Skip that CSV row** or **Overwrite** is selected.

## Included example CSV

`examples/South Oldham Lady Slammerz.csv` is a complete sample with player and
coach variants, visibility flags, filenames, mapped text, and shirt metadata. It
preserves `DURHAM`'s jersey value as `OO` (letter O twice), exactly as supplied.
Confirm whether the customer intended `00` before production.
