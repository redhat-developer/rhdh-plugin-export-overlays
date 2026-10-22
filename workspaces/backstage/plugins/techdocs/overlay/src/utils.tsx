type TechdocsAddon = {
  scope: string;
  module: string;
  importName: string;
  Component: React.ComponentType<React.PropsWithChildren>;
  config: {
    props?: Record<string, any>;
  };
};

export type DynamicConfig = {
  techdocsAddons: TechdocsAddon[];
};

function getTechdocsAddonData(dynamicConfig: DynamicConfig): TechdocsAddon[] {
  return dynamicConfig?.techdocsAddons ?? [];
}

export function getTechdocsAddonComponents(dynamicConfig: DynamicConfig) {
  const techdocsAddonsData = getTechdocsAddonData(dynamicConfig);
  return techdocsAddonsData.map(
    ({ scope, module, importName, Component, config }) => (
      <Component key={`${scope}-${module}-${importName}`} {...config.props} />
    ),
  );
}
