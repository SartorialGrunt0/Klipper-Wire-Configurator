"""Klipper configuration section schema definitions.

Defines parameter types, defaults, enums, and required fields for all
known Klipper config sections. Used for UI rendering (dropdowns vs text inputs),
validation, and default value management.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Optional


class ParamType(str, Enum):
    STRING = "string"
    INT = "int"
    FLOAT = "float"
    BOOL = "bool"
    PIN = "pin"
    ENUM = "enum"
    MULTI_LINE = "multi_line"


@dataclass
class ParamDef:
    name: str
    param_type: ParamType = ParamType.STRING
    required: bool = False
    default: Optional[str] = None
    description: str = ""
    enum_values: list[str] = field(default_factory=list)
    min_val: Optional[float] = None
    max_val: Optional[float] = None
    unit: str = ""


@dataclass
class SectionDef:
    section_type: str
    display_name: str
    category: str  # hardware, sub_component, feature, config_helper
    component_group: str  # mainboard, sbc, toolhead, probe, accel, fan, stepper, etc.
    is_named: bool = False  # Whether it takes a name parameter
    name_references: str = ""  # What the name refers to (e.g., "stepper" for tmc sections)
    description: str = ""
    params: list[ParamDef] = field(default_factory=list)
    requires: list[str] = field(default_factory=list)  # Required sections
    max_instances: int = 0  # 0 = unlimited


def _pin(name: str, desc: str = "", required: bool = False, default: Optional[str] = None) -> ParamDef:
    return ParamDef(name=name, param_type=ParamType.PIN, required=required, default=default, description=desc)


def _float(name: str, desc: str = "", required: bool = False, default: Optional[str] = None, unit: str = "") -> ParamDef:
    return ParamDef(name=name, param_type=ParamType.FLOAT, required=required, default=default, description=desc, unit=unit)


def _int(name: str, desc: str = "", required: bool = False, default: Optional[str] = None) -> ParamDef:
    return ParamDef(name=name, param_type=ParamType.INT, required=required, default=default, description=desc)


def _str(name: str, desc: str = "", required: bool = False, default: Optional[str] = None) -> ParamDef:
    return ParamDef(name=name, param_type=ParamType.STRING, required=required, default=default, description=desc)


def _bool(name: str, desc: str = "", required: bool = False, default: Optional[str] = None) -> ParamDef:
    return ParamDef(name=name, param_type=ParamType.BOOL, required=required, default=default, description=desc)


def _enum(name: str, values: list[str], desc: str = "", required: bool = False, default: Optional[str] = None) -> ParamDef:
    return ParamDef(name=name, param_type=ParamType.ENUM, enum_values=values, required=required, default=default, description=desc)


def _ml(name: str, desc: str = "", required: bool = False, default: Optional[str] = None) -> ParamDef:
    return ParamDef(name=name, param_type=ParamType.MULTI_LINE, required=required, default=default, description=desc)


# ─── Common parameter sets ───────────────────────────────────────

STEPPER_PARAMS = [
    _float("step_distance", "Distance per step in mm", default=""),
    _float("rotation_distance", "Distance per full rotation in mm", required=True),
    _int("microsteps", "Microsteps per full step", required=True),
    _int("full_steps_per_rotation", "Steps per full motor rotation", default="200"),
    _str("gear_ratio", "Gear ratio (e.g., 80:16 or 57:11, 2:1)"),
    _float("step_pulse_duration", "Step pulse duration"),
    _pin("step_pin", "Step GPIO pin", required=True),
    _pin("dir_pin", "Direction GPIO pin", required=True),
    _pin("enable_pin", "Enable GPIO pin"),
    _pin("endstop_pin", "Endstop switch detection pin"),
    _float("position_min", "Minimum position", default="0", unit="mm"),
    _float("position_endstop", "Endstop position", unit="mm"),
    _float("position_max", "Maximum position", unit="mm"),
    _float("homing_speed", "Homing speed", default="5", unit="mm/s"),
    _float("homing_retract_dist", "Retract distance after homing", default="5", unit="mm"),
    _float("homing_retract_speed", "Retract speed after homing", default="homing_speed", unit="mm/s"),
    _float("second_homing_speed", "Second homing speed", default="homing_speed/2", unit="mm/s"),
    _bool("homing_positive_dir", "Home in positive direction"),
]

TMC_UART_PARAMS = [
    _pin("uart_pin", "UART pin for TMC communication", required=True),
    _pin("tx_pin", "UART TX pin (if separate)"),
    _str("select_pins", "Select pins for UART mux"),
    _int("uart_address", "UART address (0-3)", default="0"),
    _bool("interpolate", "Enable 256 microstep interpolation", default="True"),
    _float("run_current", "Motor run current in amps", required=True),
    _float("hold_current", "Motor hold current"),
    _float("sense_resistor", "Sense resistor value", default="0.110"),
    _int("stealthchop_threshold", "StealthChop threshold velocity", default="0"),
    _int("coolstep_threshold", "CoolStep threshold velocity"),
    _int("high_velocity_threshold", "High velocity threshold"),
    _pin("diag_pin", "Diagnostic pin for sensorless homing"),
    _str("driver_SGTHRS", "StallGuard threshold (TMC2209)"),
    _str("driver_MULTISTEP_FILT", "Multistep filter"),
    _str("driver_IHOLDDELAY", "Hold delay"),
    _str("driver_TPOWERDOWN", "Power down delay"),
    _str("driver_TBL", "Comparator blank time"),
    _str("driver_TOFF", "Off time"),
    _str("driver_HEND", "Hysteresis end value"),
    _str("driver_HSTRT", "Hysteresis start value"),
    _str("driver_PWM_AUTOGRAD", "Auto gradient"),
    _str("driver_PWM_AUTOSCALE", "Auto scale"),
    _str("driver_PWM_LIM", "PWM limit"),
    _str("driver_PWM_REG", "PWM regulation"),
    _str("driver_PWM_FREQ", "PWM frequency"),
    _str("driver_PWM_GRAD", "PWM gradient"),
    _str("driver_PWM_OFS", "PWM offset"),
    _str("driver_FREEWHEEL", "Freewheel mode"),
    _str("driver_SEMIN", "CoolStep minimum current"),
    _str("driver_SEUP", "CoolStep current up step"),
    _str("driver_SEMAX", "CoolStep maximum current"),
    _str("driver_SEDN", "CoolStep current down step"),
    _str("driver_SEIMIN", "CoolStep minimum current setting"),
]

TMC_SPI_PARAMS = [
    _pin("cs_pin", "SPI chip select pin", required=True),
    _str("spi_bus", "SPI bus"),
    _str("spi_speed", "SPI speed"),
    _pin("spi_software_sclk_pin", "Software SPI clock pin"),
    _pin("spi_software_mosi_pin", "Software SPI MOSI pin"),
    _pin("spi_software_miso_pin", "Software SPI MISO pin"),
    _int("chain_position", "SPI daisy-chain position"),
    _int("chain_length", "SPI daisy-chain length"),
    _bool("interpolate", "Enable 256 microstep interpolation", default="True"),
    _float("run_current", "Motor run current in amps", required=True),
    _float("hold_current", "Motor hold current"),
    _float("sense_resistor", "Sense resistor value", default="0.110"),
    _int("stealthchop_threshold", "StealthChop threshold velocity", default="0"),
    _int("coolstep_threshold", "CoolStep threshold velocity"),
    _int("high_velocity_threshold", "High velocity threshold"),
    _pin("diag0_pin", "Diagnostic pin 0 for sensorless homing"),
    _pin("diag1_pin", "Diagnostic pin 1 for sensorless homing"),
    _str("driver_SGT", "StallGuard threshold (TMC SPI drivers)"),
    _str("driver_*", "TMC driver register override"),
]

SENSOR_TYPE_ENUM = [
    "EPCOS 100K B57560G104F", "ATC Semitec 104GT-2", "ATC Semitec 104NT-4-R025H42G",
    "Generic 3950", "Honeywell 100K 135-104LAG-J01", "NTC 100K MGB18-104F39050L32",
    "SliceEngineering 450", "TDK NTCG104LH104JT1",
    "PT100 INA826", "PT1000", "AD595", "AD597", "AD8494", "AD8495", "AD8496", "AD8497",
    "MAX6675", "MAX31855", "MAX31856", "MAX31865",
    "BME280", "AHT10", "HTU21D", "SHT21", "lm75", "temperature_mcu", "temperature_host",
    "DS18B20", "temperature_combined",
]

SOFTWARE_SPI_PARAMS = [
    _str("spi_bus", "SPI bus"),
    _pin("spi_software_sclk_pin", "Software SPI clock"),
    _pin("spi_software_mosi_pin", "Software SPI MOSI"),
    _pin("spi_software_miso_pin", "Software SPI MISO"),
]

SOFTWARE_I2C_PARAMS = [
    _str("i2c_mcu", "I2C MCU name"),
    _str("i2c_bus", "I2C bus name"),
    _pin("i2c_software_scl_pin", "Software I2C SCL pin"),
    _pin("i2c_software_sda_pin", "Software I2C SDA pin"),
    _int("i2c_speed", "I2C speed"),
]

# ─── Section Definitions ────────────────────────────────────────

SECTION_DEFS: dict[str, SectionDef] = {}


def _register(sd: SectionDef):
    SECTION_DEFS[sd.section_type] = sd


# ── MCU ──
_register(SectionDef(
    section_type="mcu",
    display_name="MCU",
    category="hardware",
    component_group="mcu",
    is_named=True,
    description="Micro-controller configuration",
    params=[
        _str("serial", "Serial port device path"),  # required only when not using canbus
        _int("baud", "Baud rate", default="250000"),
        _str("canbus_uuid", "CAN bus UUID"),  # required only when not using serial
        _str("canbus_interface", "CAN bus interface", default="can0"),
        _enum("restart_method", ["arduino", "cheetah", "rpi_usb", "command"], "Restart method"),
    ],
))

# ── Printer / Kinematics ──
KINEMATICS_TYPES = [
    "cartesian", "corexy", "corexz", "delta", "deltesian",
    "polar", "rotary_delta", "winch", "hybrid_corexy", "hybrid_corexz",
    "generic_cartesian", "none",
]

_register(SectionDef(
    section_type="printer",
    display_name="Printer",
    category="sub_component",
    component_group="printer",
    description="Printer kinematics and limits",
    max_instances=1,
    params=[
        _enum("kinematics", KINEMATICS_TYPES, "Kinematics type", required=True),
        _float("max_velocity", "Maximum velocity", required=True, default="300", unit="mm/s"),
        _float("max_accel", "Maximum acceleration", required=True, default="3000", unit="mm/s²"),
        _float("max_z_velocity", "Maximum Z velocity", default="5", unit="mm/s"),
        _float("max_z_accel", "Maximum Z acceleration", default="100", unit="mm/s²"),
        _float("minimum_z_position", "Minimum Z position", unit="mm"),
        _float("delta_radius", "Delta radius", unit="mm"),
        _float("print_radius", "Printable radius", unit="mm"),
        _float("min_angle", "Minimum deltesian arm angle", unit="degrees"),
        _float("print_width", "Printable width", unit="mm"),
        _float("slow_ratio", "Deltesian slowdown ratio"),
        _float("shoulder_radius", "Rotary delta shoulder radius", unit="mm"),
        _float("shoulder_height", "Rotary delta shoulder height", unit="mm"),
        _float("minimum_cruise_ratio", "Minimum cruise ratio", default="0.5"),
        _float("square_corner_velocity", "Square corner velocity", default="5.0", unit="mm/s"),
    ],
))

# ── Steppers ──
for axis in ["stepper_x", "stepper_y", "stepper_z"]:
    _register(SectionDef(
        section_type=axis,
        display_name=f"Stepper {axis[-1].upper()}",
        category="sub_component",
        component_group="stepper",
        description=f"{axis[-1].upper()}-axis stepper motor",
        max_instances=1,
        params=STEPPER_PARAMS[:],
    ))

# Additional steppers for the same axis
for axis in ["x", "y", "z"]:
    for i in range(1, 4):
        _register(SectionDef(
            section_type=f"stepper_{axis}{i}",
            display_name=f"Stepper {axis.upper()}{i}",
            category="sub_component",
            component_group="stepper",
            description=f"Additional {axis.upper()}-axis stepper motor {i}",
            params=[
                _float("rotation_distance", "Distance per full rotation in mm"),
                _int("microsteps", "Microsteps per full step"),
                _int("full_steps_per_rotation", "Steps per full motor rotation", default="200"),
                _str("gear_ratio", "Gear ratio"),
                _pin("step_pin", "Step GPIO pin", required=True),
                _pin("dir_pin", "Direction GPIO pin", required=True),
                _pin("enable_pin", "Enable GPIO pin"),
                _pin("endstop_pin", "Endstop pin"),
            ],
        ))

# Lettered steppers are overloaded by kinematics such as delta,
# rotary_delta, and winch.
LETTERED_STEPPER_PARAMS = [
    _float("step_distance", "Distance per step in mm", default=""),
    _float("rotation_distance", "Distance per full rotation in mm"),
    _int("microsteps", "Microsteps per full step", required=True),
    _int("full_steps_per_rotation", "Steps per full motor rotation", default="200"),
    _str("gear_ratio", "Gear ratio (for geared rotary_delta steppers)"),
    _float("step_pulse_duration", "Step pulse duration"),
    _pin("step_pin", "Step GPIO pin", required=True),
    _pin("dir_pin", "Direction GPIO pin", required=True),
    _pin("enable_pin", "Enable GPIO pin"),
    _pin("endstop_pin", "Endstop switch detection pin"),
    _float("position_min", "Minimum position", default="0", unit="mm"),
    _float("position_endstop", "Endstop position", unit="mm"),
    _float("position_max", "Maximum position", unit="mm"),
    _float("homing_speed", "Homing speed", default="5", unit="mm/s"),
    _float("homing_retract_dist", "Retract distance after homing", default="5", unit="mm"),
    _float("homing_retract_speed", "Retract speed after homing", default="homing_speed", unit="mm/s"),
    _float("second_homing_speed", "Second homing speed", default="homing_speed/2", unit="mm/s"),
    _bool("homing_positive_dir", "Home in positive direction"),
    _float("arm_length", "Delta arm length", unit="mm"),
    _float("angle", "Tower or arm angle", unit="degrees"),
    _float("upper_arm_length", "Rotary delta upper arm length", unit="mm"),
    _float("lower_arm_length", "Rotary delta lower arm length", unit="mm"),
    _float("anchor_x", "Winch anchor X coordinate", unit="mm"),
    _float("anchor_y", "Winch anchor Y coordinate", unit="mm"),
    _float("anchor_z", "Winch anchor Z coordinate", unit="mm"),
]

for tower_name in [chr(tower_ord) for tower_ord in range(ord("a"), ord("z") + 1) if chr(tower_ord) not in {"x", "y", "z"}]:
    tower = f"stepper_{tower_name}"
    _register(SectionDef(
        section_type=tower,
        display_name=f"Stepper {tower[-1].upper()}",
        category="sub_component",
        component_group="stepper",
        description=f"Lettered kinematics stepper {tower[-1].upper()}",
        params=LETTERED_STEPPER_PARAMS[:],
    ))

# ── Extruder ──
_register(SectionDef(
    section_type="extruder",
    display_name="Extruder",
    category="sub_component",
    component_group="extruder",
    description="Extruder and hotend configuration",
    params=[
        _float("rotation_distance", "Distance per full rotation", required=True, unit="mm"),
        _int("microsteps", "Microsteps per full step", required=True),
        _int("full_steps_per_rotation", "Steps per full motor rotation", default="200"),
        _str("gear_ratio", "Gear ratio"),
        _float("step_pulse_duration", "Step pulse duration"),
        _float("nozzle_diameter", "Nozzle diameter", required=True, unit="mm"),
        _float("filament_diameter", "Filament diameter", required=True, default="1.750", unit="mm"),
        _float("max_extrude_cross_section", "Max extrude cross section"),
        _float("instantaneous_corner_velocity", "Instantaneous corner velocity", default="1", unit="mm/s"),
        _float("max_extrude_only_distance", "Max extrude-only distance", default="50", unit="mm"),
        _float("max_extrude_only_velocity", "Max extrude-only velocity", unit="mm/s"),
        _float("max_extrude_only_accel", "Max extrude-only acceleration", unit="mm/s²"),
        _pin("step_pin", "Step GPIO pin", required=True),
        _pin("dir_pin", "Direction GPIO pin", required=True),
        _pin("enable_pin", "Enable GPIO pin"),
        _pin("heater_pin", "Heater GPIO pin", required=True),
        _float("max_power", "Maximum heater power", default="1.0"),
        _enum("sensor_type", SENSOR_TYPE_ENUM, "Temperature sensor type", required=True),
        _pin("sensor_pin", "Sensor analog pin"),
        _str("spi_bus", "SPI bus (for SPI sensors)"),
        _pin("spi_software_sclk_pin", "Software SPI clock"),
        _pin("spi_software_mosi_pin", "Software SPI MOSI"),
        _pin("spi_software_miso_pin", "Software SPI MISO"),
        _float("pullup_resistor", "Sensor pullup resistor", default="4700"),
        _float("inline_resistor", "Sensor inline resistor", default="0"),
        _float("smooth_time", "Temperature smoothing window", default="1.0", unit="s"),
        _enum("control", ["watermark", "pid"], "Heater control algorithm (pid or watermark)", default="pid"),
        _float("pid_Kp", "PID proportional"),
        _float("pid_Ki", "PID integral"),
        _float("pid_Kd", "PID derivative"),
        _float("pid_kp", "PID proportional (auto-saved)"),
        _float("pid_ki", "PID integral (auto-saved)"),
        _float("pid_kd", "PID derivative (auto-saved)"),
        _float("max_delta", "Max temperature delta for watermark control", default="2.0"),
        _float("pwm_cycle_time", "PWM cycle time", default="0.100", unit="s"),
        _float("min_extrude_temp", "Minimum extrude temperature", default="170", unit="°C"),
        _float("min_temp", "Minimum allowed temperature", default="0", unit="°C"),
        _float("max_temp", "Maximum allowed temperature", required=True, unit="°C"),
        _float("pressure_advance", "Pressure advance coefficient", default="0"),
        _float("pressure_advance_smooth_time", "Pressure advance smooth time", default="0.040", unit="s"),
    ],
))

# Additional extruders
for i in range(1, 8):
    _register(SectionDef(
        section_type=f"extruder{i}",
        display_name=f"Extruder {i}",
        category="sub_component",
        component_group="extruder",
        description=f"Additional extruder {i}",
        params=SECTION_DEFS["extruder"].params[:],
    ))

# ── Heater Bed ──
_register(SectionDef(
    section_type="heater_bed",
    display_name="Heater Bed",
    category="sub_component",
    component_group="heater",
    description="Heated bed configuration",
    max_instances=1,
    params=[
        _pin("heater_pin", "Heater GPIO pin", required=True),
        _enum("sensor_type", SENSOR_TYPE_ENUM, "Temperature sensor type", required=True),
        _pin("sensor_pin", "Sensor analog pin"),
        _enum("control", ["watermark", "pid"], "Control algorithm", default="pid"),
        _float("pid_Kp", "PID proportional"),
        _float("pid_Ki", "PID integral"),
        _float("pid_Kd", "PID derivative"),
        _float("pid_kp", "PID proportional (auto-saved)"),
        _float("pid_ki", "PID integral (auto-saved)"),
        _float("pid_kd", "PID derivative (auto-saved)"),
        _float("min_temp", "Minimum temperature", default="0", unit="°C"),
        _float("max_temp", "Maximum temperature", required=True, unit="°C"),
        _float("max_power", "Maximum heater power", default="1.0"),
        _float("max_delta", "Max temperature delta for watermark control", default="2.0"),
        _float("pwm_cycle_time", "PWM cycle time", default="0.100", unit="s"),
        _float("smooth_time", "Temperature smoothing window", default="1.0", unit="s"),
        _float("pullup_resistor", "Pullup resistor", default="4700"),
    ],
))

# ── Generic Heater ──
_register(SectionDef(
    section_type="heater_generic",
    display_name="Generic Heater",
    category="sub_component",
    component_group="heater",
    is_named=True,
    description="Generic heater (chamber, etc)",
    params=[
        _pin("heater_pin", "Heater GPIO pin", required=True),
        _enum("sensor_type", SENSOR_TYPE_ENUM, "Temperature sensor type", required=True),
        _pin("sensor_pin", "Sensor analog pin"),
        _enum("control", ["watermark", "pid"], "Control algorithm", default="pid"),
        _float("pid_Kp", "PID proportional"),
        _float("pid_Ki", "PID integral"),
        _float("pid_Kd", "PID derivative"),
        _float("pid_kp", "PID proportional (auto-saved)"),
        _float("pid_ki", "PID integral (auto-saved)"),
        _float("pid_kd", "PID derivative (auto-saved)"),
        _float("min_temp", "Minimum temperature", default="0", unit="°C"),
        _float("max_temp", "Maximum temperature", required=True, unit="°C"),
        _float("max_power", "Maximum heater power", default="1.0"),
        _float("max_delta", "Max temperature delta for watermark control", default="2.0"),
        _float("pwm_cycle_time", "PWM cycle time", default="0.100", unit="s"),
    ],
))

# ── TMC Drivers ──
for tmc_type in ["tmc2208", "tmc2209"]:
    _register(SectionDef(
        section_type=tmc_type,
        display_name=tmc_type.upper(),
        category="sub_component",
        component_group="stepper_driver",
        is_named=True,
        name_references="stepper",
        description=f"{tmc_type.upper()} stepper driver (UART)",
        params=TMC_UART_PARAMS[:],
    ))

for tmc_type in ["tmc2130", "tmc2240", "tmc5160"]:
    _register(SectionDef(
        section_type=tmc_type,
        display_name=tmc_type.upper(),
        category="sub_component",
        component_group="stepper_driver",
        is_named=True,
        name_references="stepper",
        description=f"{tmc_type.upper()} stepper driver (SPI)",
        params=TMC_SPI_PARAMS[:],
    ))

_register(SectionDef(
    section_type="tmc2660",
    display_name="TMC2660",
    category="sub_component",
    component_group="stepper_driver",
    is_named=True,
    name_references="stepper",
    description="TMC2660 stepper driver (SPI)",
    params=[
        _pin("cs_pin", "SPI chip select pin", required=True),
        _str("spi_bus", "SPI bus"),
        _str("spi_speed", "SPI speed", default="4000000"),
        _pin("spi_software_sclk_pin", "Software SPI clock"),
        _pin("spi_software_mosi_pin", "Software SPI MOSI"),
        _pin("spi_software_miso_pin", "Software SPI MISO"),
        _bool("interpolate", "Enable 256 microstep interpolation", default="True"),
        _float("run_current", "Motor run current in amps", required=True),
        _float("sense_resistor", "Sense resistor value", required=True),
        _int("idle_current_percent", "Idle current percent", default="100"),
    ],
))

# ── Fans ──
_register(SectionDef(
    section_type="fan",
    display_name="Part Cooling Fan",
    category="sub_component",
    component_group="fan",
    description="Part cooling fan",
    max_instances=1,
    params=[
        _pin("pin", "Fan output pin", required=True),
        _float("max_power", "Maximum power", default="1.0"),
        _float("shutdown_speed", "Shutdown speed", default="0"),
        _float("cycle_time", "PWM cycle time", default="0.010", unit="s"),
        _bool("hardware_pwm", "Use hardware PWM", default="False"),
        _float("kick_start_time", "Kick start time", default="0.100", unit="s"),
        _float("off_below", "Off below this speed", default="0.0"),
        _pin("tachometer_pin", "Tachometer input pin"),
        _int("tachometer_ppr", "Tachometer pulses per revolution", default="2"),
        _float("tachometer_poll_interval", "Tachometer poll interval", default="0.0015"),
        _pin("enable_pin", "Enable pin"),
    ],
))

_register(SectionDef(
    section_type="heater_fan",
    display_name="Heater Fan",
    category="sub_component",
    component_group="fan",
    is_named=True,
    description="Fan that turns on when a heater is active",
    params=[
        _pin("pin", "Fan output pin", required=True),
        _float("max_power", "Maximum power", default="1.0"),
        _float("shutdown_speed", "Shutdown speed", default="1.0"),
        _float("cycle_time", "PWM cycle time", default="0.010"),
        _bool("hardware_pwm", "Use hardware PWM", default="False"),
        _float("kick_start_time", "Kick start time", default="0.100"),
        _float("off_below", "Off below this speed", default="0.0"),
        _pin("tachometer_pin", "Tachometer input pin"),
        _int("tachometer_ppr", "Tachometer pulses per revolution", default="2"),
        _float("tachometer_poll_interval", "Tachometer poll interval", default="0.0015"),
        _pin("enable_pin", "Enable pin"),
        _str("heater", "Associated heater", default="extruder"),
        _float("heater_temp", "Temp threshold to enable fan", default="50.0", unit="°C"),
        _float("fan_speed", "Fan speed when heater active", default="1.0"),
    ],
))

_register(SectionDef(
    section_type="controller_fan",
    display_name="Controller Fan",
    category="sub_component",
    component_group="fan",
    is_named=True,
    description="Fan for cooling controller board",
    params=[
        _pin("pin", "Fan output pin", required=True),
        _float("max_power", "Maximum power", default="1.0"),
        _float("shutdown_speed", "Shutdown speed", default="0"),
        _float("cycle_time", "PWM cycle time", default="0.010"),
        _bool("hardware_pwm", "Use hardware PWM", default="False"),
        _float("kick_start_time", "Kick start time", default="0.100"),
        _float("off_below", "Off below this speed", default="0.0"),
        _pin("tachometer_pin", "Tachometer input pin"),
        _int("tachometer_ppr", "Tachometer pulses per revolution", default="2"),
        _float("tachometer_poll_interval", "Tachometer poll interval", default="0.0015"),
        _pin("enable_pin", "Enable pin"),
        _float("fan_speed", "Fan speed when active", default="1.0"),
        _float("idle_timeout", "Idle timeout before turning off", default="30", unit="s"),
        _float("idle_speed", "Fan speed during idle", default="fan_speed"),
        _str("heater", "Associated heater"),
        _str("stepper", "Associated stepper"),
    ],
))

_register(SectionDef(
    section_type="temperature_fan",
    display_name="Temperature Fan",
    category="sub_component",
    component_group="fan",
    is_named=True,
    description="Temperature-controlled fan",
    params=[
        _pin("pin", "Fan output pin", required=True),
        _float("max_power", "Maximum power", default="1.0"),
        _float("shutdown_speed", "Shutdown speed", default="0"),
        _float("cycle_time", "PWM cycle time", default="0.010"),
        _bool("hardware_pwm", "Use hardware PWM", default="False"),
        _float("kick_start_time", "Kick start time", default="0.100"),
        _float("off_below", "Off below this speed", default="0.0"),
        _pin("tachometer_pin", "Tachometer input pin"),
        _int("tachometer_ppr", "Tachometer pulses per revolution", default="2"),
        _float("tachometer_poll_interval", "Tachometer poll interval", default="0.0015"),
        _pin("enable_pin", "Enable pin"),
        _enum("sensor_type", SENSOR_TYPE_ENUM, "Temperature sensor type", required=True),
        _pin("sensor_pin", "Sensor pin"),
        _str("sensor_mcu", "Sensor MCU (for DS18B20)"),
        _str("serial_no", "DS18B20 serial number"),
        _float("ds18_report_time", "DS18B20 report interval", default="3.0", unit="s"),
        _float("min_temp", "Minimum temperature", default="0"),
        _float("max_temp", "Maximum temperature", required=True),
        _float("target_temp", "Target temperature", default="40.0", unit="°C"),
        _float("max_speed", "Maximum fan speed", default="1.0"),
        _float("min_speed", "Minimum fan speed", default="0.3"),
        _enum("control", ["watermark", "pid"], "Control algorithm", default="watermark"),
        _float("max_delta", "Max temp delta for watermark control", default="2.0"),
        _float("pid_Kp", "PID proportional"),
        _float("pid_Ki", "PID integral"),
        _float("pid_Kd", "PID derivative"),
        _float("pid_deriv_time", "PID derivative time", default="2.0"),
        _str("gcode_id", "G-code temperature report ID"),
    ],
))

_register(SectionDef(
    section_type="fan_generic",
    display_name="Generic Fan",
    category="sub_component",
    component_group="fan",
    is_named=True,
    description="Manually controlled generic fan",
    params=[
        _pin("pin", "Fan output pin", required=True),
        _float("max_power", "Maximum power", default="1.0"),
        _float("shutdown_speed", "Shutdown speed", default="0"),
        _float("cycle_time", "PWM cycle time", default="0.010"),
        _bool("hardware_pwm", "Use hardware PWM", default="False"),
        _float("kick_start_time", "Kick start time", default="0.100"),
        _float("off_below", "Off below this speed", default="0.0"),
        _pin("tachometer_pin", "Tachometer input pin"),
        _int("tachometer_ppr", "Tachometer pulses per revolution", default="2"),
        _float("tachometer_poll_interval", "Tachometer poll interval", default="0.0015"),
        _pin("enable_pin", "Enable pin"),
    ],
))

# ── Probes ──
_register(SectionDef(
    section_type="probe",
    display_name="Probe",
    category="sub_component",
    component_group="probe",
    description="Z-offset probe",
    max_instances=1,
    params=[
        _pin("pin", "Probe trigger pin", required=True),
        _bool("deactivate_on_each_sample", "Deactivate probe between samples", default="True"),
        _float("x_offset", "X offset from nozzle", default="0", unit="mm"),
        _float("y_offset", "Y offset from nozzle", default="0", unit="mm"),
        _float("z_offset", "Z offset", unit="mm"),
        _float("speed", "Probing speed", default="5.0", unit="mm/s"),
        _int("samples", "Number of probe samples", default="1"),
        _float("sample_retract_dist", "Retract distance between samples", default="2", unit="mm"),
        _float("samples_tolerance", "Sample tolerance", default="0.100", unit="mm"),
        _int("samples_tolerance_retries", "Max retries for tolerance", default="0"),
        _enum("samples_result", ["median", "average"], "How to calculate result", default="average"),
        _float("lift_speed", "Lift speed between samples", unit="mm/s"),
        _str("activate_gcode", "G-code to run before probing"),
        _str("deactivate_gcode", "G-code to run after probing"),
    ],
))

_register(SectionDef(
    section_type="bltouch",
    display_name="BLTouch",
    category="sub_component",
    component_group="probe",
    description="BLTouch probe",
    max_instances=1,
    params=[
        _pin("sensor_pin", "BLTouch sensor pin", required=True),
        _pin("control_pin", "BLTouch control pin", required=True),
        _float("x_offset", "X offset from nozzle", default="0", unit="mm"),
        _float("y_offset", "Y offset from nozzle", default="0", unit="mm"),
        _float("z_offset", "Z offset", unit="mm"),
        _float("speed", "Probing speed", default="5.0", unit="mm/s"),
        _int("samples", "Number of probe samples", default="1"),
        _float("sample_retract_dist", "Retract distance", default="2", unit="mm"),
        _float("samples_tolerance", "Sample tolerance", default="0.100", unit="mm"),
        _int("samples_tolerance_retries", "Max retries", default="0"),
        _enum("samples_result", ["median", "average"], "Calculation method", default="average"),
        _float("lift_speed", "Lift speed between samples", unit="mm/s"),
        _float("pin_move_time", "Pin deploy/retract time", default="0.680"),
        _bool("stow_on_each_sample", "Stow pin between samples", default="True"),
        _bool("probe_with_touch_mode", "Touch mode probing", default="False"),
        _bool("pin_up_reports_not_triggered", "Pin up reports not triggered", default="True"),
        _bool("pin_up_touch_mode_reports_triggered", "Touch mode triggered report", default="True"),
        _enum("set_output_mode", ["5V", "OD"], "Output mode"),
    ],
))

# ── Bed Leveling ──
_register(SectionDef(
    section_type="bed_mesh",
    display_name="Bed Mesh",
    category="feature",
    component_group="bed_leveling",
    description="Bed mesh compensation",
    max_instances=1,
    requires=["probe"],
    params=[
        _float("speed", "Travel speed", default="50", unit="mm/s"),
        _float("horizontal_move_z", "Z height for travel moves", default="5", unit="mm"),
        _float("mesh_radius", "Round bed mesh radius", unit="mm"),
        _str("mesh_origin", "Round bed mesh origin X,Y", default="0, 0"),
        _str("mesh_min", "Minimum mesh X,Y coordinate (e.g. 35,6)"),
        _str("mesh_max", "Maximum mesh X,Y coordinate (e.g. 240,198)"),
        _str("probe_count", "Probe count X,Y (e.g. 3,3 or 5,5)", default="3,3"),
        _int("round_probe_count", "Round bed probe count", default="5"),
        _str("mesh_pps", "Mesh points per segment", default="2,2"),
        _enum("algorithm", ["lagrange", "bicubic"], "Interpolation algorithm", default="lagrange"),
        _float("bicubic_tension", "Bicubic tension", default="0.2"),
        _float("fade_start", "Fade start height", default="1.0", unit="mm"),
        _float("fade_end", "Fade end height", default="0.0", unit="mm"),
        _float("fade_target", "Fade target Z offset", default="0"),
        _float("split_delta_z", "Split delta Z", default="0.025"),
        _float("move_check_distance", "Move check distance", default="5.0"),
        _str("zero_reference_position", "Zero reference X,Y"),
        _float("adaptive_margin", "Adaptive mesh margin", unit="mm"),
        _float("scan_overshoot", "Rapid scan overshoot", unit="mm"),
    ],
))

_register(SectionDef(
    section_type="z_tilt",
    display_name="Z Tilt",
    category="feature",
    component_group="bed_leveling",
    description="Z tilt adjustment with multiple Z motors",
    max_instances=1,
    params=[
        _ml("z_positions", "Z motor positions (one X,Y per line)", required=True),
        _ml("points", "Probe points for tilt calculation (one X,Y per line)", required=True),
        _float("speed", "Travel speed", default="50", unit="mm/s"),
        _float("horizontal_move_z", "Z height for moves", default="5", unit="mm"),
        _int("retries", "Number of retries", default="0"),
        _float("retry_tolerance", "Retry tolerance", default="0"),
    ],
))

_register(SectionDef(
    section_type="quad_gantry_level",
    display_name="Quad Gantry Level",
    category="feature",
    component_group="bed_leveling",
    description="Quad gantry leveling (4 Z motors)",
    max_instances=1,
    params=[
        _ml("gantry_corners", "Gantry corner positions", required=True),
        _ml("points", "Probe points", required=True),
        _float("speed", "Travel speed", default="50", unit="mm/s"),
        _float("horizontal_move_z", "Z height for moves", default="5", unit="mm"),
        _float("max_adjust", "Maximum adjustment", default="4"),
        _int("retries", "Number of retries", default="0"),
        _float("retry_tolerance", "Retry tolerance", default="0"),
    ],
))

_register(SectionDef(
    section_type="screws_tilt_adjust",
    display_name="Screws Tilt Adjust",
    category="feature",
    component_group="bed_leveling",
    max_instances=1,
    params=[
        _str("screw1", "First screw X,Y position", required=True),
        _str("screw1_name", "First screw name"),
        _str("screw2", "Second screw X,Y position"),
        _str("screw2_name", "Second screw name"),
        _str("screw3", "Third screw X,Y position"),
        _str("screw3_name", "Third screw name"),
        _str("screw4", "Fourth screw X,Y position"),
        _str("screw4_name", "Fourth screw name"),
        _str("screw*_name", "Additional screw name"),
        _float("speed", "Travel speed", default="50", unit="mm/s"),
        _float("horizontal_move_z", "Z height", default="5", unit="mm"),
        _enum("screw_thread", ["CW-M3", "CCW-M3", "CW-M4", "CCW-M4", "CW-M5", "CCW-M5"], "Screw thread type", default="CW-M3"),
        _str("screw*", "Additional screw X,Y position"),
    ],
))

_register(SectionDef(
    section_type="bed_screws",
    display_name="Bed Screws",
    category="feature",
    component_group="bed_leveling",
    max_instances=1,
    params=[
        _str("screw1", "Screw 1 X,Y position", required=True),
        _str("screw1_name", "Screw 1 name"),
        _str("screw1_fine_adjust", "Screw 1 fine adjust X,Y"),
        _str("screw2", "Screw 2 X,Y position"),
        _str("screw2_name", "Screw 2 name"),
        _str("screw3", "Screw 3 X,Y position"),
        _str("screw3_name", "Screw 3 name"),
        _str("screw4", "Screw 4 X,Y position"),
        _str("screw4_name", "Screw 4 name"),
        _str("screw*_fine_adjust", "Additional screw fine adjust X,Y"),
        _str("screw*_name", "Additional screw name"),
        _str("screw*", "Additional screw X,Y position"),
        _float("speed", "Travel speed", default="50", unit="mm/s"),
        _float("horizontal_move_z", "Z height for moves", default="5", unit="mm"),
        _float("probe_height", "Probe height", default="0"),
        _float("probe_speed", "Probe speed", default="5"),
    ],
))

_register(SectionDef(
    section_type="bed_tilt",
    display_name="Bed Tilt",
    category="feature",
    component_group="bed_leveling",
    max_instances=1,
    params=[
        _ml("points", "Probe points", required=True),
        _float("speed", "Travel speed", default="50", unit="mm/s"),
        _float("horizontal_move_z", "Z height", default="5", unit="mm"),
        _float("x_adjust", "X tilt adjustment", default="0"),
        _float("y_adjust", "Y tilt adjustment", default="0"),
        _float("z_adjust", "Z adjustment", default="0"),
    ],
))

_register(SectionDef(
    section_type="skew_correction",
    display_name="Skew Correction",
    category="feature",
    component_group="bed_leveling",
    max_instances=1,
    params=[],
))

# ── Homing ──
_register(SectionDef(
    section_type="safe_z_home",
    display_name="Safe Z Home",
    category="feature",
    component_group="homing",
    max_instances=1,
    params=[
        _str("home_xy_position", "X,Y position for Z homing", required=True),
        _float("speed", "Travel speed", default="50.0", unit="mm/s"),
        _float("z_hop", "Z hop before homing", default="0.0", unit="mm"),
        _float("z_hop_speed", "Z hop speed", default="15.0", unit="mm/s"),
        _bool("move_to_previous", "Return to previous position after homing", default="False"),
    ],
))

_register(SectionDef(
    section_type="homing_override",
    display_name="Homing Override",
    category="feature",
    component_group="homing",
    max_instances=1,
    params=[
        _ml("gcode", "G-code to run instead of normal homing", required=True),
        _str("axes", "Axes to override (e.g. xyz)"),
        _float("set_position_x", "Override reported X position"),
        _float("set_position_y", "Override reported Y position"),
        _float("set_position_z", "Override reported Z position"),
    ],
))

_register(SectionDef(
    section_type="endstop_phase",
    display_name="Endstop Phase",
    category="feature",
    component_group="homing",
    is_named=True,
    params=[
        _int("endstop_accuracy", "Endstop accuracy"),
        _str("trigger_phase", "Trigger phase"),
        _bool("endstop_align_zero", "Align endstop to zero"),
    ],
))

# ── Resonance / Input Shaper ──
_register(SectionDef(
    section_type="input_shaper",
    display_name="Input Shaper",
    category="feature",
    component_group="resonance",
    max_instances=1,
    params=[
        _enum("shaper_type", ["mzv", "ei", "2hump_ei", "3hump_ei", "zv", "zvd"], "Input shaper type for all axes"),
        _enum("shaper_type_x", ["mzv", "ei", "2hump_ei", "3hump_ei", "zv", "zvd"], "X shaper type", default="mzv"),
        _float("shaper_freq_x", "X shaper frequency", default="0", unit="Hz"),
        _enum("shaper_type_y", ["mzv", "ei", "2hump_ei", "3hump_ei", "zv", "zvd"], "Y shaper type", default="mzv"),
        _float("shaper_freq_y", "Y shaper frequency", default="0", unit="Hz"),
        _enum("shaper_type_z", ["mzv", "ei", "2hump_ei", "3hump_ei", "zv", "zvd"], "Z shaper type"),
        _float("shaper_freq_z", "Z shaper frequency", default="0", unit="Hz"),
        _float("damping_ratio_x", "X damping ratio", default="0.1"),
        _float("damping_ratio_y", "Y damping ratio", default="0.1"),
        _float("damping_ratio_z", "Z damping ratio", default="0.1"),
    ],
))

_register(SectionDef(
    section_type="adxl345",
    display_name="ADXL345 Accelerometer",
    category="sub_component",
    component_group="accelerometer",
    is_named=True,
    params=[
        _pin("cs_pin", "SPI chip select pin"),
        _str("spi_bus", "SPI bus"),
        _str("spi_speed", "SPI speed", default="5000000"),
        _pin("spi_software_sclk_pin", "Software SPI clock"),
        _pin("spi_software_mosi_pin", "Software SPI MOSI"),
        _pin("spi_software_miso_pin", "Software SPI MISO"),
        _str("axes_map", "Axes mapping", default="x,y,z"),
        _float("rate", "Sample rate", default="3200"),
    ],
))

for accel in ["lis2dw", "lis3dh", "bmi160", "mpu9250", "icm20948"]:
    _register(SectionDef(
        section_type=accel,
        display_name=accel.upper() + " Accelerometer",
        category="sub_component",
        component_group="accelerometer",
        is_named=True,
        params=[
            _pin("cs_pin", "SPI/I2C chip select pin"),
            _str("spi_speed", "SPI speed"),
            _str("spi_bus", "SPI bus"),
            _pin("spi_software_sclk_pin", "Software SPI clock"),
            _pin("spi_software_mosi_pin", "Software SPI MOSI"),
            _pin("spi_software_miso_pin", "Software SPI MISO"),
            _str("i2c_mcu", "I2C MCU name"),
            _str("i2c_bus", "I2C bus"),
            _pin("i2c_software_scl_pin", "Software I2C SCL pin"),
            _pin("i2c_software_sda_pin", "Software I2C SDA pin"),
            _int("i2c_speed", "I2C speed"),
            _str("i2c_address", "I2C address"),
            _str("axes_map", "Axes mapping", default="x,y,z"),
        ],
    ))

_register(SectionDef(
    section_type="resonance_tester",
    display_name="Resonance Tester",
    category="feature",
    component_group="resonance",
    max_instances=1,
    requires=["adxl345"],
    params=[
        _str("accel_chip", "Accelerometer chip reference"),
        _str("accel_chip_x", "X-axis accelerometer"),
        _str("accel_chip_y", "Y-axis accelerometer"),
        _str("accel_chip_z", "Z-axis accelerometer"),
        _str("probe_points", "Probe points for testing (X,Y,Z)", required=True),
        _float("accel_per_hz", "Acceleration per Hz", default="75"),
        _float("accel_per_hz_z", "Z-axis acceleration per Hz", default="15"),
        _float("hz_per_sec", "Hz per second", default="1"),
        _float("max_freq", "Maximum frequency", default="133.33", unit="Hz"),
        _float("max_freq_z", "Maximum Z frequency", default="100", unit="Hz"),
        _float("max_smoothing", "Maximum smoothing"),
        _float("min_freq", "Minimum frequency", default="5", unit="Hz"),
        _float("move_speed", "Move speed between test points", default="50", unit="mm/s"),
        _float("sweeping_accel", "Sweeping move acceleration", default="400", unit="mm/s²"),
        _float("sweeping_accel_z", "Z-axis sweeping acceleration", default="50", unit="mm/s²"),
        _float("sweeping_period", "Sweeping move period", default="1.2", unit="s"),
    ],
))

_register(SectionDef(
    section_type="shaketune",
    display_name="Shake&Tune",
    category="feature",
    component_group="accelerometer",
    max_instances=1,
    params=[
        _str("result_folder", "Processed results directory"),
        _int("number_of_results_to_keep", "Number of processed results to retain"),
        _bool("keep_raw_data", "Keep raw .stdata files", default="False"),
        _bool("show_macros_in_webui", "Expose Shake&Tune macros in the web UI", default="True"),
        _int("timeout", "Maximum graph processing time", default="600"),
        _int("measurements_chunk_size", "Measurements per chunk written to disk", default="2"),
        _int("max_freq", "Maximum PSD cutoff frequency", default="200"),
        _int("dpi", "Generated graph DPI", default="300"),
    ],
))

# ── Temperature Sensors ──
_register(SectionDef(
    section_type="temperature_sensor",
    display_name="Temperature Sensor",
    category="sub_component",
    component_group="temperature",
    is_named=True,
    params=[
        _enum("sensor_type", SENSOR_TYPE_ENUM, "Sensor type", required=True),
        _pin("sensor_pin", "Sensor pin"),
        _str("sensor_mcu", "Sensor MCU (for DS18B20/temperature_mcu)"),
        _str("serial_no", "DS18B20 serial number"),
        _float("ds18_report_time", "DS18B20 report interval", default="3.0", unit="s"),
        _str("sensor_path", "Host sensor file path"),
        _str("sensor_list", "List of sensors to combine (temperature_combined)"),
        _enum("combination_method", ["max", "min", "mean"], "Combination method (temperature_combined)"),
        _float("maximum_deviation", "Maximum deviation between combined sensors"),
        _float("sensor_temperature1", "First calibration temperature"),
        _float("sensor_adc1", "First calibration ADC value"),
        _float("sensor_temperature2", "Second calibration temperature"),
        _float("sensor_adc2", "Second calibration ADC value"),
        _float("adc_voltage", "ADC reference voltage"),
        _float("voltage_offset", "ADC voltage offset"),
        _float("pullup_resistor", "Sensor pullup resistor", default="4700"),
        _float("inline_resistor", "Sensor inline resistor", default="0"),
        _str("spi_bus", "SPI bus (for SPI sensors)"),
        _pin("spi_software_sclk_pin", "Software SPI clock"),
        _pin("spi_software_mosi_pin", "Software SPI MOSI"),
        _pin("spi_software_miso_pin", "Software SPI MISO"),
        _float("min_temp", "Minimum temperature", default="0"),
        _float("max_temp", "Maximum temperature", default="100"),
        _str("gcode_id", "G-code ID for temperature reporting"),
    ],
))

_register(SectionDef(
    section_type="thermistor",
    display_name="Custom Thermistor",
    category="config_helper",
    component_group="temperature",
    is_named=True,
    params=[
        _float("temperature1", "First calibration temperature", required=True),
        _float("resistance1", "First calibration resistance", required=True),
        _float("temperature2", "Second calibration temperature"),
        _float("resistance2", "Second calibration resistance"),
        _float("temperature3", "Third calibration temperature"),
        _float("resistance3", "Third calibration resistance"),
        _float("beta", "Beta coefficient"),
    ],
))

# ── LEDs ──
_register(SectionDef(
    section_type="neopixel",
    display_name="NeoPixel LED",
    category="sub_component",
    component_group="led",
    is_named=True,
    params=[
        _pin("pin", "Data pin", required=True),
        _int("chain_count", "Number of LEDs in chain", default="1"),
        _str("color_order", "Color order (can be comma-separated list for per-LED ordering)", default="GRB"),
        _float("initial_RED", "Initial red value", default="0.0"),
        _float("initial_GREEN", "Initial green value", default="0.0"),
        _float("initial_BLUE", "Initial blue value", default="0.0"),
        _float("initial_WHITE", "Initial white value", default="0.0"),
    ],
))

_register(SectionDef(
    section_type="dotstar",
    display_name="DotStar LED",
    category="sub_component",
    component_group="led",
    is_named=True,
    params=[
        _pin("data_pin", "Data pin", required=True),
        _pin("clock_pin", "Clock pin", required=True),
        _int("chain_count", "Number of LEDs", default="1"),
        _float("initial_RED", "Initial red", default="0.0"),
        _float("initial_GREEN", "Initial green", default="0.0"),
        _float("initial_BLUE", "Initial blue", default="0.0"),
    ],
))

_register(SectionDef(
    section_type="led",
    display_name="LED",
    category="sub_component",
    component_group="led",
    is_named=True,
    params=[
        _pin("red_pin", "Red LED pin"),
        _pin("green_pin", "Green LED pin"),
        _pin("blue_pin", "Blue LED pin"),
        _pin("white_pin", "White LED pin"),
        _float("cycle_time", "PWM cycle time", default="0.010"),
        _bool("hardware_pwm", "Use hardware PWM", default="False"),
        _float("initial_RED", "Initial red", default="0.0"),
        _float("initial_GREEN", "Initial green", default="0.0"),
        _float("initial_BLUE", "Initial blue", default="0.0"),
        _float("initial_WHITE", "Initial white", default="0.0"),
    ],
))

# ── Servos / Pins ──
_register(SectionDef(
    section_type="servo",
    display_name="Servo",
    category="sub_component",
    component_group="servo",
    is_named=True,
    params=[
        _pin("pin", "Servo PWM pin", required=True),
        _float("maximum_servo_angle", "Maximum angle", default="180", unit="°"),
        _float("minimum_pulse_width", "Minimum pulse width", default="0.001", unit="s"),
        _float("maximum_pulse_width", "Maximum pulse width", default="0.002", unit="s"),
        _float("initial_angle", "Initial angle", unit="°"),
        _float("initial_pulse_width", "Initial pulse width", unit="s"),
    ],
))

_register(SectionDef(
    section_type="output_pin",
    display_name="Output Pin",
    category="sub_component",
    component_group="pin",
    is_named=True,
    params=[
        _pin("pin", "Output pin", required=True),
        _bool("pwm", "Enable PWM output", default="False"),
        _float("value", "Initial value", default="0"),
        _float("shutdown_value", "Shutdown value", default="0"),
        _float("cycle_time", "PWM cycle time", default="0.100"),
        _bool("hardware_pwm", "Use hardware PWM", default="False"),
        _float("scale", "PWM scale factor"),
        _float("maximum", "Maximum value", default="1.0"),
        _float("minimum", "Minimum value", default="0.0"),
    ],
))

_register(SectionDef(
    section_type="gcode_button",
    display_name="G-Code Button",
    category="sub_component",
    component_group="pin",
    is_named=True,
    params=[
        _pin("pin", "Button pin", required=True),
        _float("analog_pullup_resistor", "Analog pullup resistor"),
        _str("analog_range", "Analog range"),
        _ml("press_gcode", "G-code on press"),
        _ml("release_gcode", "G-code on release"),
    ],
))

# ── Filament Sensors ──
_register(SectionDef(
    section_type="filament_switch_sensor",
    display_name="Filament Switch Sensor",
    category="sub_component",
    component_group="filament_sensor",
    is_named=True,
    params=[
        _pin("switch_pin", "Switch pin", required=True),
        _float("pause_delay", "Pause delay", default="0.5", unit="s"),
        _bool("pause_on_runout", "Pause on runout", default="True"),
        _ml("runout_gcode", "Runout G-code"),
        _ml("insert_gcode", "Insert G-code"),
        _float("event_delay", "Event delay", default="3"),
    ],
))

_register(SectionDef(
    section_type="filament_motion_sensor",
    display_name="Filament Motion Sensor",
    category="sub_component",
    component_group="filament_sensor",
    is_named=True,
    params=[
        _pin("switch_pin", "Encoder pin", required=True),
        _float("detection_length", "Detection length", default="7.0", unit="mm"),
        _str("extruder", "Associated extruder", default="extruder"),
        _bool("pause_on_runout", "Pause on runout", default="True"),
        _ml("runout_gcode", "Runout G-code"),
        _ml("insert_gcode", "Insert G-code"),
        _float("event_delay", "Event delay", default="3"),
    ],
))

# ── Display ──
_register(SectionDef(
    section_type="display",
    display_name="Display",
    category="sub_component",
    component_group="display",
    description="LCD display",
    params=[
        _enum("lcd_type", [
            "hd44780", "hd44780_spi", "aip31068_spi", "st7920", "uc1701", "ssd1306", "sh1106",
            "emulated_st7920", "pcd8544",
        ], "LCD type", required=True),
        _str("display_group", "Display data group name"),
        _int("menu_timeout", "Menu timeout in seconds"),
        _bool("menu_reverse_navigation", "Reverse menu navigation", default="False"),
        _pin("rs_pin", "RS pin (HD44780)"),
        _pin("e_pin", "Enable pin (HD44780)"),
        _pin("d4_pin", "Data pin 4 (HD44780)"),
        _pin("d5_pin", "Data pin 5 (HD44780)"),
        _pin("d6_pin", "Data pin 6 (HD44780)"),
        _pin("d7_pin", "Data pin 7 (HD44780)"),
        _pin("latch_pin", "Latch pin (HD44780 SPI)"),
        _pin("cs_pin", "SPI chip select"),
        _pin("dc_pin", "Display data/command pin"),
        _pin("sclk_pin", "SPI clock"),
        _pin("sid_pin", "SPI data"),
        _pin("en_pin", "Enable pin (emulated ST7920)"),
        _pin("a0_pin", "A0/DC pin"),
        _pin("rst_pin", "Reset pin"),
        _pin("reset_pin", "Reset pin"),
        _pin("spi_software_sclk_pin", "Software SPI clock pin"),
        _pin("spi_software_mosi_pin", "Software SPI MOSI pin"),
        _pin("spi_software_miso_pin", "Software SPI MISO pin"),
        _str("spi_bus", "SPI bus name"),
        _int("spi_speed", "SPI speed"),
        _str("i2c_mcu", "I2C MCU name"),
        _str("i2c_bus", "I2C bus name"),
        _pin("i2c_software_scl_pin", "Software I2C SCL pin"),
        _pin("i2c_software_sda_pin", "Software I2C SDA pin"),
        _int("i2c_speed", "I2C speed"),
        _pin("encoder_pins", "Encoder pins"),
        _pin("click_pin", "Click/enter button pin"),
        _pin("back_pin", "Back button pin"),
        _pin("up_pin", "Up button pin"),
        _pin("down_pin", "Down button pin"),
        _pin("kill_pin", "Kill button pin"),
        _float("analog_pullup_resistor", "Analog pullup"),
        _str("analog_range_click_pin", "Analog range for click pin"),
        _str("analog_range_back_pin", "Analog range for back pin"),
        _str("analog_range_up_pin", "Analog range for up pin"),
        _str("analog_range_down_pin", "Analog range for down pin"),
        _str("analog_range_kill_pin", "Analog range for kill pin"),
        _enum("encoder_steps_per_detent", ["2", "4"], "Encoder steps per detent"),
        _str("menu_root", "Root menu"),
        _bool("hd44780_protocol_init", "Initialize HD44780 protocol", default="True"),
        _int("line_length", "Display line length"),
        _int("contrast", "LCD contrast"),
        _int("vcomh", "VCOMH value (SSD1306)"),
        _bool("invert", "Invert display colors", default="False"),
        _int("x_offset", "Display X offset"),
    ],
))

_register(SectionDef(
    section_type="display_status",
    display_name="Display Status",
    category="feature",
    component_group="display",
    max_instances=1,
    params=[],
))

_register(SectionDef(
    section_type="menu",
    display_name="Menu",
    category="feature",
    component_group="display",
    is_named=True,
    params=[
        _enum("type", ["disabled", "command", "input", "list", "text", "vsdlist"], "Menu entry type", required=True),
        _str("name", "Menu entry display name"),
        _str("enable", "Template controlling whether the entry is shown"),
        _int("index", "Insertion index within the parent list"),
        _str("input", "Initial input value template"),
        _str("input_min", "Minimum input value template"),
        _str("input_max", "Maximum input value template"),
        _str("input_step", "Input step size"),
        _bool("realtime", "Run gcode as input changes", default="False"),
        _ml("gcode", "Menu action gcode"),
    ],
))

_register(SectionDef(
    section_type="display_glyph",
    display_name="Display Glyph",
    category="config_helper",
    component_group="display",
    is_named=True,
    params=[
        _ml("data", "16x16 glyph data"),
        _ml("hd44780_data", "5x8 hd44780 glyph data"),
        _int("hd44780_slot", "hd44780 glyph slot"),
    ],
))

# ── G-Code Features ──
_register(SectionDef(
    section_type="virtual_sdcard",
    display_name="Virtual SD Card",
    category="feature",
    component_group="gcode",
    max_instances=1,
    params=[
        _str("path", "Path to virtual SD card directory", required=True),
        _ml("on_error_gcode", "G-code on error"),
    ],
))

_register(SectionDef(
    section_type="pause_resume",
    display_name="Pause/Resume",
    category="feature",
    component_group="gcode",
    max_instances=1,
    params=[
        _float("recover_velocity", "Recovery velocity", default="50", unit="mm/s"),
    ],
))

_register(SectionDef(
    section_type="firmware_retraction",
    display_name="Firmware Retraction",
    category="feature",
    component_group="gcode",
    max_instances=1,
    params=[
        _float("retract_length", "Retraction length", default="0", unit="mm"),
        _float("retract_speed", "Retraction speed", default="20", unit="mm/s"),
        _float("unretract_extra_length", "Extra unretract length", default="0", unit="mm"),
        _float("unretract_speed", "Unretract speed", default="10", unit="mm/s"),
    ],
))

_register(SectionDef(
    section_type="force_move",
    display_name="Force Move",
    category="feature",
    component_group="gcode",
    max_instances=1,
    params=[
        _bool("enable_force_move", "Enable force move", default="False"),
    ],
))

_register(SectionDef(
    section_type="idle_timeout",
    display_name="Idle Timeout",
    category="feature",
    component_group="gcode",
    max_instances=1,
    params=[
        _ml("gcode", "G-code to run on idle timeout"),
        _float("timeout", "Idle timeout", default="600", unit="s"),
    ],
))

_register(SectionDef(
    section_type="gcode_macro",
    display_name="G-Code Macro",
    category="feature",
    component_group="gcode",
    is_named=True,
    params=[
        _ml("gcode", "G-code commands", required=True),
        _str("rename_existing", "Rename existing command"),
        _str("description", "Macro description"),
        _ml("variable_*", "Macro variables"),
    ],
))

_register(SectionDef(
    section_type="delayed_gcode",
    display_name="Delayed G-Code",
    category="feature",
    component_group="gcode",
    is_named=True,
    params=[
        _ml("gcode", "G-code commands", required=True),
        _float("initial_duration", "Initial delay", default="0", unit="s"),
    ],
))

_register(SectionDef(
    section_type="save_variables",
    display_name="Save Variables",
    category="feature",
    component_group="gcode",
    max_instances=1,
    params=[
        _str("filename", "File to save variables", required=True),
    ],
))

_register(SectionDef(
    section_type="gcode_arcs",
    display_name="G-Code Arcs",
    category="feature",
    component_group="gcode",
    max_instances=1,
    params=[
        _float("resolution", "Arc resolution", default="1.0", unit="mm"),
    ],
))

_register(SectionDef(
    section_type="respond",
    display_name="Respond",
    category="feature",
    component_group="gcode",
    max_instances=1,
    params=[
        _enum("default_type", ["echo", "command", "error"], "Default response type", default="echo"),
        _str("default_prefix", "Default prefix", default="echo:"),
    ],
))

_register(SectionDef(
    section_type="exclude_object",
    display_name="Exclude Object",
    category="feature",
    component_group="gcode",
    max_instances=1,
    params=[],
))

_register(SectionDef(
    section_type="autotune_tmc",
    display_name="TMC Autotune",
    category="feature",
    component_group="stepper_driver",
    is_named=True,
    description="Automatic TMC driver configuration and tuning",
    params=[
        _str("motor", "Motor database name", required=True),
        _enum("tuning_goal", ["auto", "silent", "performance", "autoswitch"], "Autotune strategy", default="auto"),
        _int("extra_hysteresis", "Additional hysteresis"),
        _int("tbl", "Comparator blank time"),
        _int("toff", "Slow decay time"),
        _int("sgt", "Sensorless homing threshold"),
        _int("sg4_thrs", "StallGuard4 threshold"),
        _int("semin", "CoolStep lower threshold"),
        _int("semax", "CoolStep upper threshold"),
        _int("seup", "CoolStep current increment step"),
        _int("sedn", "CoolStep current decrement step"),
        _int("seimin", "CoolStep lower motor current limit"),
        _float("pwm_freq_target", "PWM target switching frequency", unit="Hz"),
        _float("voltage", "Motor supply voltage", default="24", unit="V"),
        _float("overvoltage_vth", "Optional overvoltage snubber threshold", unit="V"),
    ],
))

_register(SectionDef(
    section_type="motor_constants",
    display_name="Motor Constants",
    category="config_helper",
    component_group="stepper_driver",
    is_named=True,
    description="User-defined motor constants for TMC autotune",
    params=[
        _float("resistance", "Coil resistance", required=True),
        _float("inductance", "Coil inductance", required=True),
        _float("holding_torque", "Holding torque", required=True),
        _float("max_current", "Nominal rated current", required=True),
        _int("steps_per_revolution", "Steps per revolution", required=True, default="200"),
    ],
))

_register(SectionDef(
    section_type="motor_alias",
    display_name="Motor Alias",
    category="config_helper",
    component_group="stepper_driver",
    is_named=True,
    description="Alias to another TMC autotune motor definition",
    params=[
        _str("motor", "Target motor definition", required=True),
        _bool("deprecated", "Whether the alias is deprecated"),
    ],
))

# ── Board Pins ──
_register(SectionDef(
    section_type="board_pins",
    display_name="Board Pins",
    category="config_helper",
    component_group="mcu",
    is_named=True,
    params=[
        _str("mcu", "MCU reference"),
        _ml("aliases", "Pin aliases", required=True),
    ],
))

# ── Include ──
_register(SectionDef(
    section_type="include",
    display_name="Include",
    category="config_helper",
    component_group="config",
    is_named=True,
    params=[],
))

# ── Others ──
_register(SectionDef(
    section_type="verify_heater",
    display_name="Verify Heater",
    category="config_helper",
    component_group="heater",
    is_named=True,
    params=[
        _float("max_error", "Maximum error", default="120"),
        _float("check_gain_time", "Check gain time", default="20", unit="s"),
        _float("hysteresis", "Hysteresis", default="5"),
        _float("heating_gain", "Minimum heating gain", default="2"),
    ],
))

_register(SectionDef(
    section_type="manual_stepper",
    display_name="Manual Stepper",
    category="sub_component",
    component_group="stepper",
    is_named=True,
    params=[
        _float("rotation_distance", "Distance per rotation", required=True),
        _int("microsteps", "Microsteps", required=True),
        _int("full_steps_per_rotation", "Full steps per rotation", default="200"),
        _str("gear_ratio", "Gear ratio"),
        _pin("step_pin", "Step pin", required=True),
        _pin("dir_pin", "Direction pin", required=True),
        _pin("enable_pin", "Enable pin"),
        _pin("endstop_pin", "Endstop pin"),
        _float("velocity", "Max velocity", default="5", unit="mm/s"),
        _float("accel", "Max acceleration", default="0"),
    ],
))

_register(SectionDef(
    section_type="extruder_stepper",
    display_name="Extruder Stepper",
    category="sub_component",
    component_group="stepper",
    is_named=True,
    params=[
        _str("extruder", "Target extruder"),
        _float("rotation_distance", "Distance per rotation", required=True),
        _int("microsteps", "Microsteps", required=True),
        _pin("step_pin", "Step pin", required=True),
        _pin("dir_pin", "Direction pin", required=True),
        _pin("enable_pin", "Enable pin"),
    ],
))

_register(SectionDef(
    section_type="dual_carriage",
    display_name="Dual Carriage",
    category="sub_component",
    component_group="stepper",
    is_named=True,
    params=[
        _str("primary_carriage", "Primary carriage paired with this dual carriage"),
        _enum("axis", ["x", "y"], "Axis for dual carriage"),
        _float("safe_distance", "Safe distance between carriages", default="0", unit="mm"),
        _pin("endstop_pin", "Endstop switch detection pin"),
        _float("position_min", "Minimum position", default="0", unit="mm"),
        _float("position_endstop", "Endstop position", unit="mm"),
        _float("position_max", "Maximum position", unit="mm"),
        _float("homing_speed", "Homing speed", default="5", unit="mm/s"),
        _float("homing_retract_dist", "Retract distance after homing", default="5", unit="mm"),
        _float("homing_retract_speed", "Retract speed after homing", default="homing_speed", unit="mm/s"),
        _float("second_homing_speed", "Second homing speed", default="homing_speed/2", unit="mm/s"),
        _bool("homing_positive_dir", "Home in positive direction"),
        _pin("step_pin", "Step GPIO pin"),
        _pin("dir_pin", "Direction GPIO pin"),
        _pin("enable_pin", "Enable GPIO pin"),
        _float("rotation_distance", "Distance per full rotation in mm"),
        _int("microsteps", "Microsteps per full step"),
        _int("full_steps_per_rotation", "Steps per full motor rotation", default="200"),
        _str("gear_ratio", "Gear ratio"),
        _float("step_pulse_duration", "Step pulse duration"),
    ],
))

_register(SectionDef(
    section_type="carriage",
    display_name="Carriage",
    category="sub_component",
    component_group="stepper",
    is_named=True,
    params=[
        _enum("axis", ["x", "y", "z"], "Axis for the carriage"),
        _pin("endstop_pin", "Endstop switch detection pin", required=True),
        _float("position_min", "Minimum position", default="0", unit="mm"),
        _float("position_endstop", "Endstop position", required=True, unit="mm"),
        _float("position_max", "Maximum position", required=True, unit="mm"),
        _float("homing_speed", "Homing speed", default="5", unit="mm/s"),
        _float("homing_retract_dist", "Retract distance after homing", default="5", unit="mm"),
        _float("homing_retract_speed", "Retract speed after homing", default="homing_speed", unit="mm/s"),
        _float("second_homing_speed", "Second homing speed", default="homing_speed/2", unit="mm/s"),
        _bool("homing_positive_dir", "Home in positive direction"),
    ],
))

_register(SectionDef(
    section_type="extra_carriage",
    display_name="Extra Carriage",
    category="sub_component",
    component_group="stepper",
    is_named=True,
    params=[
        _str("primary_carriage", "Primary carriage that this extra carriage follows", required=True),
        _pin("endstop_pin", "Endstop switch detection pin", required=True),
    ],
))

_register(SectionDef(
    section_type="stepper",
    display_name="Generic Stepper",
    category="sub_component",
    component_group="stepper",
    is_named=True,
    params=[
        _str("carriages", "Carriages moved by this stepper", required=True),
        _pin("step_pin", "Step GPIO pin", required=True),
        _pin("dir_pin", "Direction GPIO pin", required=True),
        _pin("enable_pin", "Enable GPIO pin"),
        _float("rotation_distance", "Distance per full rotation in mm", required=True),
        _int("microsteps", "Microsteps per full step", required=True),
        _int("full_steps_per_rotation", "Steps per full motor rotation", default="200"),
        _str("gear_ratio", "Gear ratio"),
        _float("step_pulse_duration", "Step pulse duration"),
    ],
))

_register(SectionDef(
    section_type="stepper_left",
    display_name="Stepper Left",
    category="sub_component",
    component_group="stepper",
    params=STEPPER_PARAMS[:] + [
        _float("arm_length", "Diagonal rod length", unit="mm"),
        _float("arm_x_length", "Horizontal arm distance when homed", unit="mm"),
    ],
))

_register(SectionDef(
    section_type="stepper_right",
    display_name="Stepper Right",
    category="sub_component",
    component_group="stepper",
    params=STEPPER_PARAMS[:] + [
        _float("arm_length", "Diagonal rod length", unit="mm"),
        _float("arm_x_length", "Horizontal arm distance when homed", unit="mm"),
    ],
))

_register(SectionDef(
    section_type="stepper_bed",
    display_name="Stepper Bed",
    category="sub_component",
    component_group="stepper",
    params=[
        _float("step_distance", "Distance per step in mm", default=""),
        _float("rotation_distance", "Distance per full rotation in mm"),
        _int("microsteps", "Microsteps per full step", required=True),
        _int("full_steps_per_rotation", "Steps per full motor rotation", default="200"),
        _str("gear_ratio", "Gear ratio", required=True),
        _float("step_pulse_duration", "Step pulse duration"),
        _pin("step_pin", "Step GPIO pin", required=True),
        _pin("dir_pin", "Direction GPIO pin", required=True),
        _pin("enable_pin", "Enable GPIO pin"),
        _pin("endstop_pin", "Endstop switch detection pin"),
        _float("position_min", "Minimum position", default="0", unit="mm"),
        _float("position_endstop", "Endstop position", unit="mm"),
        _float("position_max", "Maximum position", unit="mm"),
        _float("homing_speed", "Homing speed", default="5", unit="mm/s"),
        _float("homing_retract_dist", "Retract distance after homing", default="5", unit="mm"),
        _float("homing_retract_speed", "Retract speed after homing", default="homing_speed", unit="mm/s"),
        _float("second_homing_speed", "Second homing speed", default="homing_speed/2", unit="mm/s"),
        _bool("homing_positive_dir", "Home in positive direction"),
    ],
))

_register(SectionDef(
    section_type="stepper_arm",
    display_name="Stepper Arm",
    category="sub_component",
    component_group="stepper",
    params=STEPPER_PARAMS[:],
))

_register(SectionDef(
    section_type="multi_pin",
    display_name="Multi Pin",
    category="config_helper",
    component_group="pin",
    is_named=True,
    params=[
        _str("pins", "Comma-separated list of pins", required=True),
    ],
))

_register(SectionDef(
    section_type="duplicate_pin_override",
    display_name="Duplicate Pin Override",
    category="config_helper",
    component_group="config",
    max_instances=1,
    params=[
        _str("pins", "Pins allowed to be duplicated"),
    ],
))

_register(SectionDef(
    section_type="static_digital_output",
    display_name="Static Digital Output",
    category="config_helper",
    component_group="pin",
    is_named=True,
    params=[
        _str("pins", "Comma-separated list of pins to set high", required=True),
    ],
))

_register(SectionDef(
    section_type="z_thermal_adjust",
    display_name="Z Thermal Adjust",
    category="feature",
    component_group="bed_leveling",
    max_instances=1,
    params=[
        _float("temp_coeff", "Temperature coefficient"),
        _enum("sensor_type", SENSOR_TYPE_ENUM, "Sensor type"),
        _pin("sensor_pin", "Sensor pin"),
        _float("smooth_time", "Smooth time", default="2.0"),
        _float("min_temp", "Min temp", default="0"),
        _float("max_temp", "Max temp", default="100"),
    ],
))

_register(SectionDef(
    section_type="smart_effector",
    display_name="Smart Effector",
    category="sub_component",
    component_group="probe",
    max_instances=1,
    params=[
        _pin("pin", "Probe pin", required=True),
        _pin("control_pin", "Control pin"),
        _float("probe_accel", "Probe acceleration"),
        _float("recovery_time", "Recovery time", default="0.4"),
        _float("x_offset", "X offset", default="0"),
        _float("y_offset", "Y offset", default="0"),
        _float("z_offset", "Z offset"),
        _float("speed", "Speed", default="5.0"),
        _int("samples", "Samples", default="1"),
    ],
))

_register(SectionDef(
    section_type="probe_eddy_current",
    display_name="Eddy Current Probe",
    category="sub_component",
    component_group="probe",
    is_named=True,
    params=[
        _enum("sensor_type", ["ldc1612"], "Sensor type", required=True),
        _int("frequency", "Sensor crystal frequency"),
        _pin("intb_pin", "Sensor interrupt pin"),
        _float("descend_z", "Probe descend distance", required=True),
        _str("i2c_address", "I2C address"),
        _str("i2c_mcu", "I2C MCU name"),
        _str("i2c_bus", "I2C bus name"),
        _pin("i2c_software_scl_pin", "Software I2C SCL pin"),
        _pin("i2c_software_sda_pin", "Software I2C SDA pin"),
        _int("i2c_speed", "I2C speed"),
        _float("x_offset", "X offset", default="0"),
        _float("y_offset", "Y offset", default="0"),
        _float("z_offset", "Z offset"),
        _float("speed", "Speed", default="5.0"),
    ],
))

_register(SectionDef(
    section_type="load_cell",
    display_name="Load Cell",
    category="sub_component",
    component_group="probe",
    is_named=True,
    params=[
        _enum("sensor_type", ["HX711", "HX717", "ADS1220"], "Sensor type", required=True),
        _pin("sclk_pin", "Clock pin"),
        _pin("dout_pin", "Data out pin"),
        _str("gain", "Gain"),
        _str("sample_rate", "Sample rate"),
    ],
))

_register(SectionDef(
    section_type="angle",
    display_name="Angle Sensor",
    category="sub_component",
    component_group="sensor",
    is_named=True,
    params=[
        _enum("sensor_type", ["a1333", "as5047d", "tle5012b"], "Sensor type", required=True),
        _str("sample_period", "Sample period", default="0.000400"),
        _pin("cs_pin", "Chip select pin"),
        _str("spi_bus", "SPI bus"),
        _str("spi_speed", "SPI speed"),
        _pin("spi_software_sclk_pin", "SW SPI clock"),
        _pin("spi_software_mosi_pin", "SW SPI MOSI"),
        _pin("spi_software_miso_pin", "SW SPI MISO"),
    ],
))

_register(SectionDef(
    section_type="palette2",
    display_name="Palette 2",
    category="sub_component",
    component_group="other",
    max_instances=1,
    params=[
        _str("serial", "Serial port", required=True),
        _int("baud", "Baud rate", default="115200"),
        _float("feedrate_splice", "Splice feedrate", default="0.8"),
        _float("feedrate_normal", "Normal feedrate", default="1.0"),
        _float("auto_load_speed", "Auto load speed", default="2"),
        _float("auto_cancel_variation", "Auto cancel variation", default="0.1"),
    ],
))

# ── Digipots/DACs (brief) ──
for chip_type in ["ad5206", "mcp4728"]:
    _register(SectionDef(
        section_type=chip_type,
        display_name=chip_type.upper(),
        category="sub_component",
        component_group="stepper_driver",
        is_named=True,
        params=[
            _pin("enable_pin", "Enable pin"),
            _str("i2c_bus", "I2C bus"),
            _str("i2c_address", "I2C address"),
            _str("spi_bus", "SPI bus"),
            _pin("cs_pin", "SPI chip select"),
            _str("channel_*", "Channel values"),
            _str("scale", "Scale factor"),
        ],
    ))

_register(SectionDef(
    section_type="mcp4451",
    display_name="MCP4451",
    category="sub_component",
    component_group="stepper_driver",
    is_named=True,
    params=[
        _pin("enable_pin", "Enable pin"),
        _str("i2c_bus", "I2C bus"),
        _str("i2c_address", "I2C address"),
        _pin("i2c_software_scl_pin", "Software I2C SCL pin"),
        _pin("i2c_software_sda_pin", "Software I2C SDA pin"),
        _int("i2c_speed", "I2C speed"),
        _str("wiper_*", "Digital potentiometer wiper value"),
        _str("scale", "Scale factor"),
    ],
))

_register(SectionDef(
    section_type="mcp4018",
    display_name="MCP4018",
    category="sub_component",
    component_group="stepper_driver",
    is_named=True,
    params=[
        _pin("enable_pin", "Enable pin"),
        _str("i2c_bus", "I2C bus"),
        _str("i2c_address", "I2C address"),
        _pin("i2c_software_scl_pin", "Software I2C SCL pin"),
        _pin("i2c_software_sda_pin", "Software I2C SDA pin"),
        _int("i2c_speed", "I2C speed"),
        _str("wiper", "Digital potentiometer wiper value", required=True),
        _str("scale", "Scale factor"),
    ],
))

# ── Board-specific (brief) ──
_register(SectionDef(
    section_type="sx1509",
    display_name="Sx1509",
    category="config_helper",
    component_group="hardware",
    is_named=True,
    params=[
        _int("i2c_address", "I2C address", required=True),
        _str("i2c_mcu", "I2C MCU name"),
        _str("i2c_bus", "I2C bus name"),
        _pin("i2c_software_scl_pin", "Software I2C SCL pin"),
        _pin("i2c_software_sda_pin", "Software I2C SDA pin"),
        _int("i2c_speed", "I2C speed"),
    ],
))

_register(SectionDef(
    section_type="samd_sercom",
    display_name="Samd Sercom",
    category="config_helper",
    component_group="hardware",
    is_named=True,
    params=[
        _str("sercom", "SERCOM bus name", required=True),
        _pin("tx_pin", "SERCOM TX or SDA pin", required=True),
        _pin("rx_pin", "SERCOM RX or MISO pin"),
        _pin("clk_pin", "SERCOM clock or SCL pin", required=True),
    ],
))

_register(SectionDef(
    section_type="ads1x1x",
    display_name="Ads1x1x",
    category="config_helper",
    component_group="hardware",
    is_named=True,
    params=[],
))

_register(SectionDef(
    section_type="replicape",
    display_name="Replicape",
    category="config_helper",
    component_group="hardware",
    params=[
        _enum("revision", ["B3"], "Replicape revision", required=True),
        _pin("enable_pin", "Global enable pin"),
        _str("host_mcu", "Linux process MCU section name", required=True),
        _bool("standstill_power_down", "Allow motors to power down at standstill", default="False"),
        _str("stepper_*_microstep_mode", "Microstep mode for a given stepper"),
        _float("stepper_*_current", "Current for a given stepper"),
    ],
))

_register(SectionDef(
    section_type="adc_scaled",
    display_name="Adc Scaled",
    category="config_helper",
    component_group="hardware",
    is_named=True,
    params=[
        _pin("vref_pin", "ADC VREF monitoring pin", required=True),
        _pin("vssa_pin", "ADC VSSA monitoring pin", required=True),
        _float("smooth_time", "ADC smoothing window", default="2.0"),
    ],
))

# ── PCA LED controllers ──
for pca in ["pca9533", "pca9632"]:
    _register(SectionDef(
        section_type=pca,
        display_name=pca.upper() + " LED",
        category="sub_component",
        component_group="led",
        is_named=True,
        params=[
            _str("i2c_bus", "I2C bus"),
            _str("i2c_address", "I2C address"),
            _float("initial_RED", "Initial red", default="0"),
            _float("initial_GREEN", "Initial green", default="0"),
            _float("initial_BLUE", "Initial blue", default="0"),
            _float("initial_WHITE", "Initial white", default="0"),
        ],
    ))

_register(SectionDef(
    section_type="delta_calibrate",
    display_name="Delta Calibrate",
    category="feature",
    component_group="bed_leveling",
    max_instances=1,
    params=[
        _float("radius", "Probe radius"),
        _float("speed", "Speed", default="50"),
        _float("horizontal_move_z", "Move Z height", default="5"),
    ],
))

_register(SectionDef(
    section_type="axis_twist_compensation",
    display_name="Axis Twist Compensation",
    category="feature",
    component_group="bed_leveling",
    max_instances=1,
    params=[
        _float("speed", "Speed", default="50"),
        _float("horizontal_move_z", "Z height", default="5"),
        _int("calibrate_start_x", "Start X"),
        _int("calibrate_end_x", "End X"),
        _int("calibrate_y", "Y position"),
    ],
))

_register(SectionDef(
    section_type="temperature_probe",
    display_name="Temperature Probe",
    category="sub_component",
    component_group="temperature",
    is_named=True,
    params=[
        _enum("sensor_type", SENSOR_TYPE_ENUM, "Sensor type", required=True),
        _pin("sensor_pin", "Sensor pin"),
        _float("adc_voltage", "ADC reference voltage"),
        _float("voltage_offset", "ADC voltage offset"),
        _float("pullup_resistor", "Sensor pullup resistor", default="4700"),
        _float("inline_resistor", "Sensor inline resistor", default="0"),
        _str("spi_bus", "SPI bus (for SPI sensors)"),
        _pin("spi_software_sclk_pin", "Software SPI clock"),
        _pin("spi_software_mosi_pin", "Software SPI MOSI"),
        _pin("spi_software_miso_pin", "Software SPI MISO"),
        _float("horizontal_move_z", "Z height for probe moves"),
        _float("min_temp", "Min temp", default="0"),
        _float("max_temp", "Max temp", default="100"),
        _str("smooth_time", "Smooth time"),
    ],
))

_register(SectionDef(
    section_type="adc_temperature",
    display_name="ADC Temperature",
    category="config_helper",
    component_group="temperature",
    is_named=True,
    params=[
        _float("temperature*", "Calibration temperature"),
        _float("voltage*", "Calibration voltage"),
        _float("resistance*", "Calibration resistance"),
    ],
))

_register(SectionDef(
    section_type="homing_heaters",
    display_name="Homing Heaters",
    category="config_helper",
    component_group="heater",
    max_instances=1,
    params=[
        _str("steppers", "Steppers that trigger heater disable"),
        _str("heaters", "Heaters to disable during homing"),
    ],
))

_register(SectionDef(
    section_type="pwm_tool",
    display_name="PWM Tool",
    category="sub_component",
    component_group="pin",
    is_named=True,
    params=[
        _pin("pin", "PWM pin", required=True),
        _float("maximum_mcu_duration", "Max MCU duration", default="0"),
        _float("value", "Initial value", default="0"),
        _float("shutdown_value", "Shutdown value", default="0"),
        _float("cycle_time", "Cycle time", default="0.100"),
        _bool("hardware_pwm", "Hardware PWM", default="False"),
        _float("scale", "Scale factor"),
    ],
))

_register(SectionDef(
    section_type="pwm_cycle_time",
    display_name="PWM Cycle Time",
    category="sub_component",
    component_group="pin",
    is_named=True,
    params=[
        _pin("pin", "PWM pin", required=True),
        _float("value", "Initial value", default="0"),
        _float("shutdown_value", "Shutdown value", default="0"),
        _float("cycle_time", "Cycle time", default="0.100"),
        _float("scale", "Scale"),
    ],
))

_register(SectionDef(
    section_type="sdcard_loop",
    display_name="SD Card Loop",
    category="feature",
    component_group="gcode",
    max_instances=1,
    params=[],
))

# ── Moonraker ──
# `[update_manager <name>]` sections are Moonraker config (not Klipper), so
# they have no Klipper schema — register them as a known named section so the
# validator stops flagging every one as "Unknown section type". No params are
# required; the common Moonraker options are listed for form rendering.
_register(SectionDef(
    section_type="update_manager",
    display_name="Moonraker Update Manager",
    category="config_helper",
    component_group="system",
    is_named=True,
    description="Moonraker update_manager entry (git_repo/web/command...) — validated by Moonraker, not Klipper",
    params=[
        _str("type", "Update source type (git_repo, web, command, zip, json_file)"),
        _str("repo", "GitHub repo (owner/name)"),
        _str("path", "Local path of the installed software"),
        _str("origin", "Git remote origin URL"),
        _str("primary_branch", "Primary branch tracked for updates"),
        _str("channel", "Release channel (stable/beta/dev)"),
        _str("managed_services", "Systemd services to restart after update"),
        _str("install_script", "Path to the install script"),
        _str("requirements", "Path to a pip requirements file"),
        _str("system_dependencies", "System packages to install"),
        _str("virtualenv", "Path to the virtualenv to update"),
        _str("env", "Environment variables for the update command"),
        _int("refresh_interval", "Update check interval (hours)"),
    ],
))


def get_section_def(section_type: str) -> Optional[SectionDef]:
    """Get the schema for a section type."""
    return SECTION_DEFS.get(section_type)


def get_all_section_types() -> list[str]:
    """Get all registered section types."""
    return sorted(SECTION_DEFS.keys())


def get_sections_by_category(category: str) -> list[SectionDef]:
    """Get all section definitions for a category."""
    return [sd for sd in SECTION_DEFS.values() if sd.category == category]


def get_sections_by_group(group: str) -> list[SectionDef]:
    """Get all section definitions for a component group."""
    return [sd for sd in SECTION_DEFS.values() if sd.component_group == group]
