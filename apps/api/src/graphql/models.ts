import { Field, ID, ObjectType } from '@nestjs/graphql';

/** A user of the caller's tenant, as the console shows it. */
@ObjectType('User', { description: 'A user with a membership in the caller tenant.' })
export class UserModel {
  @Field(() => ID)
  readonly id!: string;

  @Field(() => String, { nullable: true })
  readonly name!: string | null;

  @Field(() => String)
  readonly email!: string;
}

/** A membership of the caller tenant: the user's roles there, and the user itself. */
@ObjectType('TenantMember', { description: 'A membership of the caller tenant.' })
export class TenantMemberModel {
  @Field(() => ID)
  readonly userId!: string;

  @Field(() => [String], { description: 'Roles held in the caller tenant.' })
  readonly roles!: readonly string[];
}
