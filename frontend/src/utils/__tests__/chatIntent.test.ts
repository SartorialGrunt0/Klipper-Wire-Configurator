import { describe, it, expect } from 'vitest';
import {
  detectChatIntent,
  findSectionHeaders,
  extractSectionText,
  extractTargetedSectionHeaders,
  buildSectionContextMessage,
} from '../chatIntent';
import { buildConfigIndexMessage } from '../chatUtils';

const SAMPLE_FILE = `# =====================
# MCU
# =====================
[mcu]
serial: /dev/ttyS0
baud: 250000

[printer]
kinematics: corexy
max_accel: 15500 #Ellis Tuned

[gcode_macro Level_Bed]
#rename_existing: _BED_MESH_CALIBRATE
gcode:
    {% if "xyz" not in printer.toolhead.homed_axes %}
      G28
    {% endif %}
    BED_MESH_CALIBRATE
    M104 S0

[fan_generic Aux_Fan]
pin: PB3
`;

describe('detectChatIntent', () => {
  it('classifies edit requests', () => {
    expect(detectChatIntent('Modify my level_bed macro to call BED_MESH_CALIBRATE in adaptive')).toBe('edit');
    expect(detectChatIntent('In printer.cfg change the [printer] max_accel to 12000')).toBe('edit');
    expect(detectChatIntent('Add a [bed_mesh] section to my config')).toBe('edit');
    expect(detectChatIntent('Delete the RESET_ACCEL macro')).toBe('edit');
    expect(detectChatIntent('Fix my macro')).toBe('edit');
  });

  it('classifies questions', () => {
    expect(detectChatIntent('What does horizontal_move_z do?')).toBe('question');
    expect(detectChatIntent('What is the default value of pressure_advance?')).toBe('question');
    expect(detectChatIntent('Help me set up my new printer from scratch')).toBe('question');
    expect(detectChatIntent('List all parameters supported by the [probe] section')).toBe('question');
    expect(detectChatIntent('')).toBe('question');
  });
});

describe('findSectionHeaders / extractSectionText', () => {
  it('finds all section headers in file order', () => {
    expect(findSectionHeaders(SAMPLE_FILE)).toEqual([
      'mcu',
      'printer',
      'gcode_macro Level_Bed',
      'fan_generic Aux_Fan',
    ]);
  });

  it('extracts a section including its banner comments', () => {
    const mcu = extractSectionText(SAMPLE_FILE, 'mcu');
    expect(mcu).toBe(`# =====================
# MCU
# =====================
[mcu]
serial: /dev/ttyS0
baud: 250000
`);
  });

  it('extracts a macro section with Jinja intact', () => {
    const lb = extractSectionText(SAMPLE_FILE, 'gcode_macro Level_Bed');
    expect(lb).toContain('[gcode_macro Level_Bed]');
    expect(lb).toContain('{% if "xyz" not in printer.toolhead.homed_axes %}');
    expect(lb).toContain('{% endif %}');
    expect(lb).toContain('BED_MESH_CALIBRATE');
    expect(lb).not.toContain('[fan_generic Aux_Fan]');
  });

  it('returns null for a missing section', () => {
    expect(extractSectionText(SAMPLE_FILE, 'gcode_macro NOPE')).toBeNull();
  });
});

describe('extractTargetedSectionHeaders', () => {
  it('matches explicit [section] references', () => {
    expect(extractTargetedSectionHeaders('edit the [printer] section', SAMPLE_FILE)).toEqual(['printer']);
  });

  it('matches "my X macro" phrasing', () => {
    expect(extractTargetedSectionHeaders('modify my level_bed macro', SAMPLE_FILE)).toEqual(['gcode_macro Level_Bed']);
  });

  it('matches "the X section" phrasing', () => {
    expect(extractTargetedSectionHeaders('change the bed_mesh... no wait, the mcu section serial', SAMPLE_FILE)).toEqual(['mcu']);
  });

  it('returns an empty list when nothing matches', () => {
    expect(extractTargetedSectionHeaders('what is pressure advance', SAMPLE_FILE)).toEqual([]);
  });

  it('deduplicates and returns file order', () => {
    expect(extractTargetedSectionHeaders('my level_bed macro and the [printer] section', SAMPLE_FILE)).toEqual([
      'printer',
      'gcode_macro Level_Bed',
    ]);
  });
});

describe('buildSectionContextMessage', () => {
  it('formats a fenced section context', () => {
    const msg = buildSectionContextMessage('printer.cfg', 'Active Klipper config draft', 'printer', '[printer]\nkinematics: corexy');
    expect(msg).toContain('printer.cfg — section [printer]');
    expect(msg).toContain('```cfg\n[printer]\nkinematics: corexy\n```');
  });
});

describe('buildConfigIndexMessage', () => {
  it('lists section headers and points at read_user_config', () => {
    const msg = buildConfigIndexMessage('printer.cfg', findSectionHeaders(SAMPLE_FILE), 'Loaded Klipper config file');
    expect(msg).toContain('printer.cfg — section index (file content not attached)');
    expect(msg).toContain('[printer]');
    expect(msg).toContain('[gcode_macro Level_Bed]');
    // Must NOT contain any section body content — only the index.
    expect(msg).not.toContain('max_accel: 15500');
    // Must tell the model how to fetch sections itself.
    expect(msg).toContain("read_user_config with filename='printer.cfg'");
  });

  it('handles a file with no detected sections', () => {
    const msg = buildConfigIndexMessage('empty.cfg', [], 'Loaded Klipper config file');
    expect(msg).toContain('(no sections detected)');
  });
});
