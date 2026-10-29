/** DI tokens of the asset module. Kept in their own file so the controller and the module do not import each other. */
export const ASSET_SERVICE = Symbol.for('blackwing.api.assets.service');
export const ASSET_METRICS = Symbol.for('blackwing.api.assets.metrics');
