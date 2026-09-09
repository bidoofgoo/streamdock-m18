//
// Device profiles for Stream Dock hardware.
//
// The numbers here are per-model and were established by reverse engineering,
// so each field records how confident we are. Anything marked UNVERIFIED is a
// guess carried over from a similar model and needs confirming on real hardware.
//

/** @typedef {'jpeg'} ImageFormat */

export const MODELS = {
  // Our device. VID/PID is not one of the four documented Stream Dock IDs, and
  // it straddles two known models: 293-like key count, N3-like report size.
  m18: {
    id: 'm18',
    // IDENTIFIED 2026-08-28 as a Stream Dock M18. Our VID/PID pair appears
    // nowhere in Mirabox's SDK (PID 0x1000 is listed as N1EN, but against VID
    // 0x6603, and the N1 is a 20-key device with knobs), so this is an
    // unlisted OEM variant. The M18 definition in the vendor SDK matches what
    // we measured on every single field: 15 keys, the same image key map, the
    // same three aux ids, rotation 0, no flip.
    name: 'VSDinside Stream Dock M18 (15 keys + 3)',
    vendorId: 0x5548,
    productId: 0x1000,

    // Verified: read from the HID report descriptor.
    outputReportSize: 1024,
    inputReportSize: 512,

    keyCols: 5,
    keyRows: 3,
    keyCount: 15,
    auxKeyCount: 3, // the 3 plain buttons with no screen

    // VERIFIED 2026-08-28 on hardware, by sweeping sizes and rotations onto
    // separate keys and reading the panel.
    //
    // 64x64 fills a key exactly. Larger images do not scale down: the device
    // blits into a fixed per-key framebuffer, so anything bigger overruns into
    // the NEXT key's memory. A 150x150 tile visibly smeared across the keys
    // below it. Always resize to exactly these dimensions.
    keyWidth: 64,
    keyHeight: 64,
    // No rotation. This panel is mounted the right way up, unlike the 293.
    keyRotation: 0,
    keyImageFormat: 'jpeg',
    maxImageBytes: 10240,

    // The device uses TWO DIFFERENT NUMBERINGS for the same physical key,
    // depending on direction. This is not a mistake in our code; it is how the
    // hardware behaves, and it cost us a confusing bug where every icon looked
    // perfect while every press fired the wrong sound two rows away.
    //
    //                    top row      middle row   bottom row
    //   images out       0x0b-0x0f    0x06-0x0a    0x01-0x05
    //   key events in    0x01-0x05    0x06-0x0a    0x0b-0x0f
    //
    // The rows are flipped between the two. The middle row is identical either
    // way, which is a good trap: any test that only touches the middle row
    // will pass regardless.
    //
    // Both lists are in grid order, so index 0 is the TOP-LEFT key.

    // Where to send a key image. VERIFIED 2026-08-28: pushing numbered tiles to
    // each raw id and reading the panel, then confirmed again when a real
    // profile rendered with "Rain" on the top-left key as intended.
    imageKeyIds: [
      0x0b, 0x0c, 0x0d, 0x0e, 0x0f,
      0x06, 0x07, 0x08, 0x09, 0x0a,
      0x01, 0x02, 0x03, 0x04, 0x05,
    ],

    // What a key press reports. VERIFIED 2026-08-28 properly: all 18 buttons
    // pressed left-to-right, top-to-bottom in a single run, with the raw ids
    // logged. They arrived strictly sequential, 0x01..0x0f then the three aux
    // ids, resolving to index 0..17 in order.
    //
    // An earlier claim that this was "verified from key press events" was
    // wrong: raw ids had been observed, but not which physical key produced
    // them, so the match was inferred rather than measured. That inference was
    // what hid the flipped numbering. Log the press order, or it is not a
    // measurement.
    inputKeyIds: [
      0x01, 0x02, 0x03, 0x04, 0x05,
      0x06, 0x07, 0x08, 0x09, 0x0a,
      0x0b, 0x0c, 0x0d, 0x0e, 0x0f,
    ],

    // The 3 plain buttons with no screen.
    //
    // IDs VERIFIED 2026-08-28: they do report on the vendor interface, with the
    // same down/up events as the grid keys, using exactly the ids the N3 uses
    // for its non-grid keys. Well outside the 0x01-0x0f grid range, so they can
    // never be confused with a screen key.
    //
    // PHYSICAL ORDER VERIFIED 2026-08-28 by pressing left, middle, right in
    // sequence: they report in exactly this order. Aux index 0/1/2 therefore
    // maps to grid index 15/16/17 as left/middle/right.
    //
    // They carry NO special meaning here, by decision (2026-09-09): an earlier
    // note reserved them for page switching, but the app owns them, so they
    // are plain buttons that report like any other key. Anything that wants
    // paging can build it on top; nothing in the driver or the daemon claims
    // them. They have no screen, so they take no images.
    auxKeyIds: [0x25, 0x30, 0x31],

    // RGB light strip. The vendor SDK declares hasRGBLed with ledCounts = 24
    // for the M18; the wire protocol was recovered from the shipped
    // libtransport_arm64.dylib, since it is absent from the published source.
    hasRgbLed: true,
    ledCount: 24,

    // The 24 addressable LEDs are NOT one continuous ring. One SETLB write
    // covers all of them, but the last two sit on the FRONT of the unit, so an
    // animation run across all 24 indices visibly walks off the ring and
    // finishes on the front. That was a real bug in `led chase`.
    //
    // VERIFIED 2026-09-09 on hardware: painted indices 0-23 in coloured bands
    // and read off where each band appeared, then narrowed the last band by
    // lighting 20/21/22/23 in four distinct colours with everything else off.
    // 0-21 are on the ring, 22 and 23 on the front. All 24 are fitted; no
    // index failed to light, so 'dark' is empty (the SDK's 24 is a per-model
    // maximum, so a related model may well have unfitted indices here).
    //
    // Re-measure on another unit with `npm run dock -- led bands`, then
    // `led spread <a> <b>` on whichever band straddles the boundary.
    //
    // Ring geometry, VERIFIED 2026-09-09 by lighting indices 0-5 in six
    // distinct colours and reading off their physical positions:
    //
    //   index 0     the MIDDLE of the LEFT edge, not a corner
    //   ascending   down the left edge, then rightwards along the bottom,
    //               then up the right edge: COUNTER-CLOCKWISE from the front
    //   0, 1, 2     left edge, lower half; 2 is the last before the corner
    //   3 - 8       the bottom edge; 3 sits just after the bottom-left corner
    //               and 8 just before the bottom-right one
    //   9, 10, 11   right edge, lower half; 11 is the MIDDLE of the right edge
    //
    // The upper half was extrapolated from that symmetry and then CONFIRMED
    // 2026-09-09 with `led corners`, which alternates the four edges red and
    // blue so every corner becomes a colour boundary: all four boundaries
    // landed on corners.
    //
    // The ring is therefore symmetric about index 0: 11 LEDs per half, index
    // 11 exactly opposite index 0, and NO LED SITS ON A CORNER. The corners
    // fall in the gaps between 2/3, 8/9, 13/14 and 19/20. An effect that wants
    // to start at a corner cannot just start at index 0, and cannot land an
    // LED on a corner at all.
    ledZones: {
      ring: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21],
      front: [22, 23],
      dark: [],
    },

    // The ring's four edges, as named sub-ranges of the 'ring' zone. Unlike
    // ledZones these OVERLAP the ring rather than partitioning the strip, so
    // they live in their own field; both are resolvable by name through
    // dock.ledIndices(). Each list is in strip order, which also runs
    // top-to-bottom or left-to-right geometrically. 'left' wraps past index 0,
    // because the strip starts in the middle of that edge.
    //
    // No LED sits on a corner; a corner falls in the GAP between two edges.
    //
    // VERIFIED 2026-09-09, both halves: `npm run dock -- led corners` paints
    // adjacent edges red/blue, and every colour change landed on a corner.
    // Re-run it on another unit; a boundary that misses a corner means that
    // edge's list is wrong.
    ledEdges: {
      left: [20, 21, 0, 1, 2],
      bottom: [3, 4, 5, 6, 7, 8],
      right: [9, 10, 11, 12, 13],
      top: [14, 15, 16, 17, 18, 19],
    },
  },
};

export function findModel(vendorId, productId) {
  return Object.values(MODELS).find(m => m.vendorId === vendorId && m.productId === productId);
}
