"""Fake extras/motion_tools.py mirroring handler-list registration."""


class PrinterGCodeMove:
    def __init__(self, gcode):
        handlers = ['G1', 'G20', 'G21', 'M82', 'SET_GCODE_OFFSET']
        for cmd in handlers:
            func = getattr(self, 'cmd_' + cmd)
            gcode.register_command(cmd, func, False)
        gcode.register_command('G0', self.cmd_G1)


class FakeMacroHelper:
    def __init__(self, gcode):
        # Dynamic name (user-macro alias) — extractor must ignore these.
        gcode.register_command(self.alias, self.cmd)
