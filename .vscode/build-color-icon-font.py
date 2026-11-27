#!/usr/bin/env python3
"""Generate resources/git-map-color-icons.woff with OpenType COLR v0 + CPAL v0 multi-color glyphs."""

import math
import os
import struct
import zlib

UNITS_PER_EM = 1000
ASCENT = 1000
DESCENT = 0
PAD = 60
SPAN = 1000 - PAD * 2  # 880 inside 0..1000 box


def svg_pt(x, y):
	"""Map 24x24 SVG (Y-down) coordinates into 1000-UPM TrueType (Y-up) font units."""
	fx = round(PAD + (x / 24.0) * SPAN)
	fy = round(PAD + ((24.0 - y) / 24.0) * SPAN)
	return (fx, fy)


def signed_area(pts):
	"""Shoelace formula in Y-up space: >0 is CCW, <0 is CW."""
	area = 0
	n = len(pts)
	for i in range(n):
		x1, y1 = pts[i][0], pts[i][1]
		x2, y2 = pts[(i + 1) % n][0], pts[(i + 1) % n][1]
		area += x1 * y2 - x2 * y1
	return area


def ensure_winding(pts, clockwise=True):
	area = signed_area(pts)
	if clockwise and area > 0:
		return list(reversed(pts))
	if not clockwise and area < 0:
		return list(reversed(pts))
	return list(pts)


def rect_contour(x1, y1, x2, y2, clockwise=True):
	pts = [
		(svg_pt(x1, y1)[0], svg_pt(x1, y1)[1], True),
		(svg_pt(x2, y1)[0], svg_pt(x2, y1)[1], True),
		(svg_pt(x2, y2)[0], svg_pt(x2, y2)[1], True),
		(svg_pt(x1, y2)[0], svg_pt(x1, y2)[1], True),
	]
	return ensure_winding(pts, clockwise)


def poly_contour(coords, clockwise=True):
	pts = [(svg_pt(x, y)[0], svg_pt(x, y)[1], True) for (x, y) in coords]
	return ensure_winding(pts, clockwise)


def circle_contour(cx, cy, r, clockwise=True):
	"""8-segment quadratic Bezier circle (16 alternating on/off curve points)."""
	pts = []
	off_scale = 1.0 / math.cos(math.pi / 8.0)
	for i in range(8):
		a_on = i * (math.pi / 4.0)
		a_off = (i + 0.5) * (math.pi / 4.0)
		ox, oy = svg_pt(cx + r * math.cos(a_on), cy + r * math.sin(a_on))
		cxp, cyp = svg_pt(cx + r * off_scale * math.cos(a_off), cy + r * off_scale * math.sin(a_off))
		pts.append((ox, oy, True))
		pts.append((cxp, cyp, False))
	return ensure_winding(pts, clockwise)


def ring_contours(cx, cy, r_outer, r_inner):
	return [circle_contour(cx, cy, r_outer, True), circle_contour(cx, cy, r_inner, False)]


def encode_glyf(contours):
	"""Encode list of contours into TrueType glyf bytes; returns (bytes, bbox, num_points)."""
	if not contours:
		return b'', (0, 0, 0, 0), 0
	all_pts = [pt for c in contours for pt in c]
	xs = [p[0] for p in all_pts]
	ys = [p[1] for p in all_pts]
	xmin, ymin, xmax, ymax = min(xs), min(ys), max(xs), max(ys)

	buf = bytearray()
	buf += struct.pack('>hhhhh', len(contours), xmin, ymin, xmax, ymax)
	end_idx = -1
	for c in contours:
		end_idx += len(c)
		buf += struct.pack('>H', end_idx)
	buf += struct.pack('>H', 0)  # instructionLength = 0

	# Flags: 0x01 for on-curve, 0x00 for off-curve; 16-bit signed coordinate deltas
	for _, _, on_curve in all_pts:
		buf.append(0x01 if on_curve else 0x00)

	prev_x = 0
	for x, _, _ in all_pts:
		buf += struct.pack('>h', x - prev_x)
		prev_x = x

	prev_y = 0
	for _, y, _ in all_pts:
		buf += struct.pack('>h', y - prev_y)
		prev_y = y

	return bytes(buf), (xmin, ymin, xmax, ymax), len(all_pts)


def pad4(data):
	rem = len(data) % 4
	return data + (b'\x00' * (4 - rem) if rem else b'')


def calc_checksum(data):
	padded = pad4(data)
	total = 0
	for i in range(0, len(padded), 4):
		total = (total + struct.unpack('>I', padded[i:i + 4])[0]) & 0xFFFFFFFF
	return total


def hex_bgra(hex_rgb, alpha=255):
	h = hex_rgb.lstrip('#')
	r = int(h[0:2], 16)
	g = int(h[2:4], 16)
	b = int(h[4:6], 16)
	return (b, g, r, alpha)


def build_font():
	# CPAL v0 color palette (0xFFFF is OpenType currentColor)
	palette = [
		hex_bgra('#C8CED6'),  # 0: Silver grey (Git Map top stem)
		hex_bgra('#38E4FF'),  # 1: Luminous sky-cyan (Git Map left track + rocket porthole)
		hex_bgra('#FF3DAE'),  # 2: Vivid magenta (Git Map center track)
		hex_bgra('#3CFF6B'),  # 3: Vivid emerald-green (Git Map diagonal branch)
		hex_bgra('#FF7A2F'),  # 4: Bright coral-orange (Rocket nose, fins, body)
		hex_bgra('#FFF8EE'),  # 5: Warm cream-white (Rocket fuselage highlight)
		hex_bgra('#FFD43B'),  # 6: Bright gold (Rocket flame & commit ring)
		hex_bgra('#34F59A'),  # 7: Vivid emerald (Editor mode default eye iris)
		hex_bgra('#F0ABFC'),  # 8: Bright orchid pink (Zen mode slash)
		hex_bgra('#FFFFFF'),  # 9: Pure white highlight
	]
	CURRENT_COLOR = 0xFFFF

	# Define geometric contour shapes for each icon
	# 1. Git Map multi-color logo (0xE001) - based on resources/webview-icon.svg
	logo_grey = [rect_contour(2.75, 0.0, 5.25, 10.5)]
	logo_magenta = [
		rect_contour(10.75, 3.0, 13.25, 24.0),
		circle_contour(12.0, 3.2, 3.1),
	]
	logo_green = [
		poly_contour([(4.2, 13.0), (20.4, 19.6), (19.6, 22.0), (3.4, 15.4)]),
		circle_contour(20.0, 20.8, 3.1),
	]
	logo_blue = [
		rect_contour(2.75, 12.0, 5.25, 24.0),
		circle_contour(4.0, 12.0, 3.1),
	]

	# 2. Rocket multi-color (0xE002) - 45 degree rocket
	rocket_flame = [
		poly_contour([(5.5, 15.5), (8.5, 18.5), (2.2, 21.8)]),
		poly_contour([(2.2, 17.5), (4.6, 16.5), (3.4, 18.9)]),
		poly_contour([(6.5, 21.8), (7.5, 19.4), (5.1, 20.6)]),
	]
	rocket_orange = [
		# Left fin
		poly_contour([(9.4, 8.8), (4.0, 9.6), (2.6, 13.2), (7.2, 13.8)]),
		# Bottom fin
		poly_contour([(15.2, 14.6), (14.4, 20.0), (10.8, 21.4), (10.2, 16.8)]),
		# Outer rocket body & nose cone
		poly_contour([
			(6.2, 15.2), (8.6, 10.0), (14.0, 4.6), (21.2, 2.8),
			(19.4, 10.0), (14.0, 15.4), (8.8, 17.8),
		]),
	]
	rocket_body = [
		poly_contour([
			(8.4, 14.4), (10.0, 11.2), (14.2, 7.0), (18.4, 5.6),
			(17.0, 9.8), (12.8, 14.0), (9.6, 15.6),
		]),
	]
	rocket_porthole = [circle_contour(14.6, 9.4, 2.2)]

	# 3. Commit icon (0xE003) - horizontal stems + gold ring + coral dot
	commit_stems = [
		rect_contour(1.2, 10.6, 6.8, 13.4),
		rect_contour(17.2, 10.6, 22.8, 13.4),
	]
	commit_ring = ring_contours(12.0, 12.0, 6.2, 3.2)
	commit_dot = [circle_contour(12.0, 12.0, 2.0)]

	# 4. Eye icon (0xE004) - Default Editor Mode
	eye_outer_ring = [
		poly_contour([
			(1.6, 12.0), (4.6, 7.2), (8.4, 5.2), (12.0, 4.8),
			(15.6, 5.2), (19.4, 7.2), (22.4, 12.0),
			(19.4, 16.8), (15.6, 18.8), (12.0, 19.2),
			(8.4, 18.8), (4.6, 16.8),
		], True),
		poly_contour([
			(4.2, 12.0), (6.8, 8.6), (9.4, 7.3), (12.0, 7.0),
			(14.6, 7.3), (17.2, 8.6), (19.8, 12.0),
			(17.2, 15.4), (14.6, 16.7), (12.0, 17.0),
			(9.4, 16.7), (6.8, 15.4),
		], False),
	]
	eye_iris = [circle_contour(12.0, 12.0, 3.8)]
	eye_pupil = [circle_contour(12.0, 12.0, 1.5)]

	# 5. Zen Eye-Off icon (0xE005)
	zen_slash = [
		poly_contour([(3.2, 4.6), (4.6, 3.2), (20.8, 19.4), (19.4, 20.8)]),
	]

	# Glyph list: glyph 0 = .notdef, 1..5 = base glyphs (with monochrome fallback), 6.. = layer glyphs
	glyphs = [[]]  # glyph 0 (.notdef)

	base_specs = [
		(0xE001, logo_grey + logo_magenta + logo_green + logo_blue, [
			(logo_grey, 0),
			(logo_magenta, 2),
			(logo_green, 3),
			(logo_blue, 1),
		]),
		(0xE002, rocket_flame + rocket_orange + rocket_porthole, [
			(rocket_flame, 6),
			(rocket_orange, 4),
			(rocket_body, 5),
			(rocket_porthole, 1),
		]),
		(0xE003, commit_stems + commit_ring, [
			(commit_stems, CURRENT_COLOR),
			(commit_ring, 6),
			(commit_dot, 4),
		]),
		(0xE004, eye_outer_ring + eye_iris, [
			(eye_outer_ring, CURRENT_COLOR),
			(eye_iris, 7),
			(eye_pupil, 9),
		]),
		(0xE005, eye_outer_ring + zen_slash, [
			(eye_outer_ring, CURRENT_COLOR),
			(zen_slash, 8),
		]),
	]

	cmap_map = {}
	for codepoint, fallback_contours, _ in base_specs:
		gid = len(glyphs)
		glyphs.append(fallback_contours)
		cmap_map[codepoint] = gid

	base_records = []
	layer_records = []
	for codepoint, _, layers in base_specs:
		base_gid = cmap_map[codepoint]
		first_layer = len(layer_records)
		for contours, pal_idx in layers:
			layer_gid = len(glyphs)
			glyphs.append(contours)
			layer_records.append((layer_gid, pal_idx))
		base_records.append((base_gid, first_layer, len(layers)))

	base_records.sort(key=lambda r: r[0])

	# Build glyf, loca, hmtx
	glyf_buf = bytearray()
	loca_offsets = []
	hmtx_buf = bytearray()
	bboxes = []
	max_points = 0
	max_contours = 0

	for contours in glyphs:
		loca_offsets.append(len(glyf_buf))
		gbytes, bbox, npts = encode_glyf(contours)
		if npts > max_points:
			max_points = npts
		if len(contours) > max_contours:
			max_contours = len(contours)
		bboxes.append(bbox)
		padded = pad4(gbytes)
		glyf_buf += padded
		lsb = bbox[0] if gbytes else 0
		hmtx_buf += struct.pack('>Hh', UNITS_PER_EM, lsb)

	loca_offsets.append(len(glyf_buf))
	loca_buf = b''.join(struct.pack('>I', off) for off in loca_offsets)

	non_empty = [b for b, g in zip(bboxes, glyphs) if g]
	font_xmin = min(b[0] for b in non_empty)
	font_ymin = min(b[1] for b in non_empty)
	font_xmax = max(b[2] for b in non_empty)
	font_ymax = max(b[3] for b in non_empty)

	# COLR v0 table
	colr_buf = bytearray()
	base_off = 14
	layer_off = base_off + 6 * len(base_records)
	colr_buf += struct.pack('>HHIIH', 0, len(base_records), base_off, layer_off, len(layer_records))
	for bgid, fl, nl in base_records:
		colr_buf += struct.pack('>HHH', bgid, fl, nl)
	for lgid, pidx in layer_records:
		colr_buf += struct.pack('>HH', lgid, pidx)

	# CPAL v0 table
	cpal_buf = bytearray()
	num_colors = len(palette)
	cpal_buf += struct.pack('>HHHHIH', 0, num_colors, 1, num_colors, 14, 0)
	for b, g, r, a in palette:
		cpal_buf += struct.pack('>BBBB', b, g, r, a)

	# cmap table (Format 4, single PUA segment 0xE001..0xE005 + 0xFFFF sentinel)
	start_codes = [0xE001, 0xFFFF]
	end_codes = [0xE005, 0xFFFF]
	id_deltas = [(cmap_map[0xE001] - 0xE001) & 0xFFFF, 1]
	id_range_offsets = [0, 0]
	seg_count = 2
	subtable = bytearray()
	subtable += struct.pack('>HHHHHHH', 4, 16 + seg_count * 8, 0, seg_count * 2, 4, 1, 0)
	for v in end_codes:
		subtable += struct.pack('>H', v)
	subtable += struct.pack('>H', 0)  # reservedPad
	for v in start_codes:
		subtable += struct.pack('>H', v)
	for v in id_deltas:
		subtable += struct.pack('>H', v)
	for v in id_range_offsets:
		subtable += struct.pack('>H', v)
	subtable_bytes = bytes(subtable)

	cmap_buf = bytearray()
	cmap_buf += struct.pack('>HH', 0, 2)  # version 0, 2 encoding records
	enc_off = 4 + 2 * 8
	cmap_buf += struct.pack('>HHI', 0, 3, enc_off)  # Unicode BMP
	cmap_buf += struct.pack('>HHI', 3, 1, enc_off)  # Windows Unicode BMP
	cmap_buf += subtable_bytes

	# head table (54 bytes, checkSumAdjustment filled later)
	head_buf = bytearray(struct.pack(
		'>HHIIIHHqqhhhhHHhhh',
		1, 0,        # majorVersion, minorVersion = 1.0
		0x00010000,  # fontRevision = 1.0
		0,           # checkSumAdjustment placeholder
		0x5F0F3CF5,  # magicNumber
		0x000B,      # flags
		UNITS_PER_EM,
		0, 0,        # created, modified timestamps
		font_xmin, font_ymin, font_xmax, font_ymax,
		0,           # macStyle
		8,           # lowestRecPPEM
		2,           # fontDirectionHint
		1,           # indexToLocFormat = 1 (long 32-bit offsets)
		0            # glyphDataFormat
	))

	# hhea table (36 bytes)
	hhea_buf = struct.pack(
		'>IhhhHhhhhhhhhhhhH',
		0x00010000,  # version 1.0
		ASCENT,
		DESCENT,
		0,           # lineGap
		UNITS_PER_EM,
		font_xmin,
		UNITS_PER_EM - font_xmax,
		font_xmax - font_xmin,
		1, 0, 0,     # caretSlopeRise, Run, Offset
		0, 0, 0, 0,  # reserved
		0,           # metricDataFormat
		len(glyphs)  # numberOfHMetrics
	)

	# maxp table (32 bytes for TrueType v1.0)
	maxp_buf = struct.pack(
		'>IH13H',
		0x00010000,
		len(glyphs),
		max_points,
		max_contours,
		0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0
	)

	# OS/2 table v4 (96 bytes)
	os2_buf = struct.pack(
		'>HhHHh11h10B4I4sHHHhhhHH2IhhHHH',
		4,                  # version
		UNITS_PER_EM,       # xAvgCharWidth
		400,                # usWeightClass
		5,                  # usWidthClass
		0,                  # fsType
		650, 600, 0, 140,   # ySubscriptXSize, YSize, XOffset, YOffset
		650, 600, 0, 480,   # ySuperscript
		50, 260,            # yStrikeoutSize, Position
		0,                  # sFamilyClass
		2, 0, 5, 3, 0, 0, 0, 0, 0, 0,  # panose
		0, 0, 0, 0,         # ulUnicodeRange 1..4 (PUA)
		b'GMAP',            # achVendID
		0x0040,             # fsSelection (REGULAR)
		0xE001, 0xE005,     # usFirstCharIndex, usLastCharIndex
		ASCENT, DESCENT, 0, # sTypoAscender, sTypoDescender, sTypoLineGap
		ASCENT, 0,          # usWinAscent, usWinDescent
		0, 0,               # ulCodePageRange 1..2
		500, 700,           # sxHeight, sCapHeight
		0, 0xE001, 1        # usDefaultChar, usBreakChar, usMaxContext
	)

	# name table
	names = [
		(1, 'Git Map Color Icons'),
		(2, 'Regular'),
		(4, 'Git Map Color Icons Regular'),
		(6, 'GitMapColorIcons-Regular'),
	]
	str_storage = bytearray()
	name_records = []
	for name_id, text in names:
		encoded = text.encode('utf-16-be')
		name_records.append((3, 1, 0x0409, name_id, len(encoded), len(str_storage)))
		str_storage += encoded
	name_buf = bytearray()
	name_buf += struct.pack('>HHH', 0, len(name_records), 6 + len(name_records) * 12)
	for rec in name_records:
		name_buf += struct.pack('>HHHHHH', *rec)
	name_buf += str_storage

	# post table v3.0 (32 bytes, no glyph names needed)
	post_buf = struct.pack('>IIhhIIIII', 0x00030000, 0, -50, 50, 0, 0, 0, 0, 0)

	raw_tables = {
		b'COLR': bytes(colr_buf),
		b'CPAL': bytes(cpal_buf),
		b'OS/2': bytes(os2_buf),
		b'cmap': bytes(cmap_buf),
		b'glyf': bytes(glyf_buf),
		b'head': bytes(head_buf),
		b'hhea': bytes(hhea_buf),
		b'hmtx': bytes(hmtx_buf),
		b'loca': bytes(loca_buf),
		b'maxp': bytes(maxp_buf),
		b'name': bytes(name_buf),
		b'post': bytes(post_buf),
	}

	sorted_tags = sorted(raw_tables.keys())
	num_tables = len(sorted_tags)

	# Compute SFNT header & checkSumAdjustment for head table
	sfnt_header_size = 12 + num_tables * 16
	sfnt_offset = sfnt_header_size
	sfnt_records = []
	sfnt_chunks = bytearray()
	head_sfnt_offset = None
	for tag in sorted_tags:
		tbl = raw_tables[tag]
		padded = pad4(tbl)
		if tag == b'head':
			head_sfnt_offset = sfnt_offset
		sfnt_records.append((tag, calc_checksum(tbl), sfnt_offset, len(tbl)))
		sfnt_chunks += padded
		sfnt_offset += len(padded)

	sfnt_dir = bytearray(struct.pack('>IHHHH', 0x00010000, num_tables, 16 * 8, 3, (num_tables - 8) * 16))
	for tag, csum, off, length in sfnt_records:
		sfnt_dir += struct.pack('>4sIII', tag, csum, off, length)

	full_sfnt = bytearray(sfnt_dir + sfnt_chunks)
	total_csum = calc_checksum(full_sfnt)
	adj = (0xB1B0AFBA - total_csum) & 0xFFFFFFFF
	head_updated = bytearray(raw_tables[b'head'])
	struct.pack_into('>I', head_updated, 8, adj)
	raw_tables[b'head'] = bytes(head_updated)

	# Recompute head checksum after setting checkSumAdjustment
	woff_header_size = 44
	woff_dir_size = num_tables * 20
	woff_data_offset = woff_header_size + woff_dir_size
	woff_records = []
	woff_chunks = bytearray()
	total_sfnt_size = sfnt_header_size
	for tag in sorted_tags:
		tbl = raw_tables[tag]
		total_sfnt_size += len(pad4(tbl))
		compressed = zlib.compress(tbl, 9)
		stored = compressed if len(compressed) < len(tbl) else tbl
		padded = pad4(stored)
		woff_records.append((tag, woff_data_offset + len(woff_chunks), len(stored), len(tbl), calc_checksum(tbl)))
		woff_chunks += padded

	woff_total_size = woff_data_offset + len(woff_chunks)
	woff_header = struct.pack(
		'>4sIIHHIHHIIIII',
		b'wOFF',
		0x00010000,
		woff_total_size,
		num_tables,
		0,
		total_sfnt_size,
		1, 0,
		0, 0, 0,
		0, 0
	)
	woff_dir = bytearray()
	for tag, off, comp_len, orig_len, csum in woff_records:
		woff_dir += struct.pack('>4sIIII', tag, off, comp_len, orig_len, csum)

	return woff_header + bytes(woff_dir) + bytes(woff_chunks)


def main():
	repo_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
	out_path = os.path.join(repo_root, 'resources', 'git-map-color-icons.woff')
	woff_bytes = build_font()
	with open(out_path, 'wb') as f:
		f.write(woff_bytes)
	print('Generated %s (%d bytes)' % (out_path, len(woff_bytes)))


if __name__ == '__main__':
	main()
