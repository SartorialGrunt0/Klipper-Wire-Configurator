import type { ConfigFile } from '../types/config';

/**
 * True when any config file already contains a section of the given type.
 * Feature sections are singletons per project (except gcode_macro, which can
 * repeat), so the AddMenu/panel uses this to disable duplicate feature adds.
 */
export function hasFeatureSectionType(
  configFiles: Record<string, ConfigFile>,
  sectionType: string,
): boolean {
  return sectionType !== 'gcode_macro' && Object.values(configFiles).some(
    (configFile) => configFile.sections.some((section) => section.section_type === sectionType),
  );
}
