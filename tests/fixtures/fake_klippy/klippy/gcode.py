"""Fake klippy/gcode.py for extractor tests."""


class GCode:
    def __init__(self, printer):
        handlers = ['M110', 'M112', 'M115', 'RESTART', 'HELP']
        for cmd in handlers:
            func = getattr(self, 'cmd_' + cmd)
            self.register_command(cmd, func, True)

    def register_command(self, cmd, func, when_not_ready=False, desc=None):
        pass

    def register_mux_command(self, cmd, key, value, func, desc=None):
        pass
