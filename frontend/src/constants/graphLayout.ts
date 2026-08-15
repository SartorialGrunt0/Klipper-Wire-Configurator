/**
 * Shared graph layout geometry constants.
 *
 * Single source of truth for hardware-container sizing, child slot
 * positioning, tile/group metrics, z-index layering, and canvas snap.
 * Previously duplicated verbatim in graphStore.ts (CONTAINER_* and
 * CHILD_* names), App.tsx (HARDWARE_DRAG_PREVIEW_*), and HardwareNode.tsx
 * (PREVIEW_*).
 */

/** Total width of a hardware container node */
export const CONTAINER_WIDTH = 400;
/** Height reserved for the hardware node header/info area */
export const CONTAINER_HEADER_HEIGHT = 110;
/** Vertical slot size per child node (compact tiles) */
export const CHILD_SLOT_HEIGHT = 40;
/** Padding below last child row */
export const CONTAINER_PADDING_BOTTOM = 16;
/** X position (relative to parent) for left-column children (features) */
export const CHILD_LEFT_X = 12;
/** X position (relative to parent) for right-column children (sub-components) */
export const CHILD_RIGHT_X = 208;
/** Height of a hardware node when collapsed (just the header) */
export const COLLAPSED_HEIGHT = 56;
/** Width of a hardware node when collapsed */
export const COLLAPSED_WIDTH = 200;

/** Height of a compact tile's header row */
export const TILE_HEADER_HEIGHT = 36;
/** Height per item row in an expanded GroupNode body */
export const GROUP_ITEM_HEIGHT = 22;
/** Vertical padding inside the expanded GroupNode body (top + bottom) */
export const GROUP_BODY_PADDING = 12;
/** Gap between tiles in a column */
export const TILE_GAP = 4;
/** Base stacking for top-level hardware cards */
export const HARDWARE_Z_INDEX = 0;
/** Elevated stacking for the selected parent hardware card */
export const SELECTED_PARENT_Z_INDEX = 100;
/** Child cards should always render above major component cards */
export const CHILD_NODE_Z_INDEX = 200;
/** Selected child cards stay above sibling cards and action overlays */
export const ACTIVE_CHILD_Z_INDEX = 300;
/** Shared canvas snap size for manual placement and auto-arrange anchors */
export const GRID_SIZE = 20;
