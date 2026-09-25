# Mission Control: Sphere

Sphere is the leftmost Mission Control tab and the default signed-in view for
accounts with the organizational planning permission. Other organization
accounts start on My Tasks. Superadmins without an active organization retain
the MSP portal. My Tasks is available to every authenticated organization
account, but each returned collection is checked against its entity permission.

## Interaction

The initial screen contains the spherical relationship map and compact controls.
Search, type/process filters, the legend, counts and instructions are disclosed
through the search button. The list button provides a keyboard-accessible,
paginated alternative with every matching record. Details appear only after
selection, grouped by connected record type, with relationship labels, saved
notes and links into existing record screens. Selected records and their direct
neighbors receive labels on the map; unrelated points dim.

Records of the same type share a region of the sphere. Colors identify types;
lines represent persisted connections. Spatial proximity does not imply another
relationship. The map rotates slowly by default; pause/resume is explicit.
Selecting or manually moving/zooming the map pauses rotation. Reduced-motion
preferences disable automatic rotation until explicitly resumed. Animation stops
when the page is hidden or another tab/view is active. Drag/pinch, keyboard
arrows, +/− and Home support direct manipulation.

Large results collapse into type groups and then smaller expandable ranges;
records are never silently discarded. Selection clears search/type restrictions
to reveal its connections; direct neighbors are expanded individually within the
scene budget. At most 180 points are drawn at once.
Very dense maps sample visual edges to bound rendering work; the details and
record list retain every relationship. Refresh reads a new snapshot. Sphere
never generates control tickets or writes records; existing record editors
remain responsible for edits.

## Data and access boundaries

- `GET /api/sphere`: one batched query per permitted registry, plus shared link
  tables. Query count does not grow with individual node count.
- `GET /api/sphere/record/:type/:id`: on-demand name, status and description.
- Both endpoints require organization context and Mission Control access, return
  `Cache-Control: no-store`, and check entity permissions and tenant ownership.
  Edges survive only when both endpoints are in the authorized node set.
- Reads cover cross-links, existing parent/foreign-key relationships, architecture
  hierarchy, document references, supplier architecture metadata, process groups,
  SoA process mappings, audit recurrence and management review report references.
- Planning process and role references use exact unique saved names only. These
  are identified as planning assignments; ambiguous names produce no edge.
- Cross-links have canonical storage ordering and are displayed without invented
  direction. Actual foreign-key/hierarchy relationships retain direction.
- Legacy `org_architecture` AI-use-case records use `arch_ai_usecase`; the existing
  `ai_usecase` cross-link alias resolves to the separate `usecase` register.
- API names/descriptions/notes are escaped before DOM rendering. Pending detail
  requests cannot reopen a closed selection. Organization/account changes clear
  cached graph state. No schema or database migration is required.

## Validation and release

Run `npm run verify`; tests use the isolated PGlite adapter and block external
network access. Coverage includes tenant/module boundaries, invalid records,
bounded queries, large-group expansion, typed layout, default landing routing,
restricted My Tasks collections, escaped integration details, late responses,
rotation lifecycle and labels for highlighted neighbors.

Check a synthetic local organization in a browser at desktop/mobile widths:
Sphere first/default, search and reset, map/list, rotation pause/resume, selection,
neighbor labels, focus and original record links. Sign in with an account without
`org` permission and confirm My Tasks, not Mission Control. Never point a test
startup at a real database. Build and include `public/sphere.css` in the normal
static asset deployment; `public/app.js` remains generated from the manifest.
