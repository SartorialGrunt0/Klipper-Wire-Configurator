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


class FakeConventionHandlers:
    """klippy/extras/gcode_move.py:22-27 shape — the handler table registers
    `func = getattr(self, 'cmd_' + cmd)`, so the registration argument is a
    LOCAL and the per-command handler is only recoverable by convention."""

    def __init__(self, gcode):
        handlers = ['SET_GCODE_STATE', 'GET_STATE']
        for cmd in handlers:
            func = getattr(self, 'cmd_' + cmd)
            desc = getattr(self, 'cmd_' + cmd + '_help', None)
            gcode.register_command(cmd, func, False, desc)

    def cmd_SET_GCODE_STATE(self, gcmd):
        self.name = gcmd.get('NAME', 'default')
        if gcmd.get_int('MOVE', 0):
            self.speed = gcmd.get_float('MOVE_SPEED', self.speed, above=0.)

    def cmd_GET_STATE(self, gcmd):
        gcmd.get_int('INDEX', 1, minval=0, maxval=self.count)
        gcmd.get_float('SPEED', 1., above=0.)
        gcmd.get_float('OFFSET', 0., minval=-1, maxval=1)

    cmd_SET_GCODE_STATE_help = "set state"


class FakeSharedDispatch:
    """One handler shared across a loop of names (gcode.py builtin shape).
    It must NOT be attributed to each name in the loop."""

    def __init__(self, gcode):
        for name in ['DISPATCH_A', 'DISPATCH_B']:
            gcode.register_command(name, self._cmd_one)

    def _cmd_one(self, gcmd):
        gcmd.get_int('ONLY', 1)


class FakeAxisLoops:
    """gcode_move.py:208 (numeric per-axis) vs homing.py:337 (presence
    per-axis) — only the numeric read is typeable."""

    def __init__(self, gcode):
        gcode.register_command('SET_FAKE_OFFSET', self.cmd_SET_FAKE_OFFSET)
        gcode.register_command('FAKE_HOME', self.cmd_FAKE_HOME)

    def cmd_SET_FAKE_OFFSET(self, gcmd):
        for pos, axis in enumerate('XYZ'):
            offset = gcmd.get_float(axis, None)
            if offset is None:
                offset = gcmd.get_float(axis + '_ADJUST', None)

    def cmd_FAKE_HOME(self, gcmd):
        axes = []
        for pos, axis in enumerate('XYZ'):
            if gcmd.get(axis, None) is not None:
                axes.append(pos)


