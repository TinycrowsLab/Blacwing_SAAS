import 'reflect-metadata';

/**
 * Declares the runtime types of a method's parameters for `@nestjs/graphql`'s argument reflection.
 *
 * The API compiles and tests without `emitDecoratorMetadata` (every injection uses an explicit `@Inject`),
 * so `design:paramtypes` is absent, and a parameter decorator such as `@Args` with an explicit `type`
 * still reads it. This writes the same metadata the compiler would emit. The lazy argument reflection runs
 * at schema build, after every method decorator has been applied.
 */
export function ParamTypes(...types: readonly unknown[]): MethodDecorator {
  return (target, propertyKey) => {
    Reflect.defineMetadata('design:paramtypes', [...types], target, propertyKey);
  };
}
