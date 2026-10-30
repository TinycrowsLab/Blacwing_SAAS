import { Field, ID, InputType, ObjectType } from '@nestjs/graphql';

/** Filters of the `assets` query. Each one narrows the list; they combine with AND. Values are validated by the resolver. */
@InputType('AssetFilter', { description: 'Filters of the asset list (combined with AND).' })
export class AssetFilterModel {
  @Field(() => String, {
    nullable: true,
    description: 'Ownership verification state: unverified, pending, verified or rejected.',
  })
  readonly verificationStatus?: string;

  @Field(() => String, {
    nullable: true,
    description: 'Asset type: web_app, api, host, network_range or source_repo.',
  })
  readonly type?: string;

  @Field(() => String, { nullable: true, description: 'Environment: prod, staging, dev or test.' })
  readonly environment?: string;

  @Field(() => String, { nullable: true, description: 'Assets with a tag of this key.' })
  readonly tagKey?: string;

  @Field(() => String, {
    nullable: true,
    description: 'With tagKey: only assets whose tag has this value.',
  })
  readonly tagValue?: string;

  @Field(() => String, { nullable: true, description: 'Assets in the group with this name.' })
  readonly group?: string;
}

/**
 * The verification of an asset (ownership proof, §8.10). `verified` is the state the scoping wizard gates selection on;
 * `method` and the dates say how and when it was proved.
 */
@ObjectType('VerificationStatus', { description: 'Ownership verification state of an asset.' })
export class VerificationStatusModel {
  @Field(() => String)
  readonly status!: string;

  @Field(() => String, { nullable: true })
  readonly method!: string | null;

  @Field(() => String, { nullable: true, description: 'ISO-8601 UTC time of verification.' })
  readonly verifiedAt!: string | null;

  @Field(() => String, {
    nullable: true,
    description: 'ISO-8601 UTC time the verification expires.',
  })
  readonly expiresAt!: string | null;
}

/**
 * A summary of the F6 environment attestation: the declared environment type and the names of the attested keys. The
 * values themselves are never exposed through GraphQL.
 */
@ObjectType('AttestationSummary', {
  description: 'Summary of the environment attestation (no values).',
})
export class AttestationSummaryModel {
  @Field(() => String, {
    nullable: true,
    description: 'The declared environment type, when attested.',
  })
  readonly environmentType!: string | null;

  @Field(() => [String], { description: 'Names of the attested keys, in order.' })
  readonly attestedKeys!: readonly string[];
}

/** A credential role of an asset. Exposes the role, its MFA type and the OpenBao reference only; never a secret value. */
@ObjectType('CredentialRole', {
  description:
    'A login role of an asset: role name, MFA type and secret reference (never the secret).',
})
export class CredentialRoleModel {
  @Field(() => String)
  readonly roleName!: string;

  @Field(() => String, { description: 'none, totp, webauthn, sms or push.' })
  readonly mfaType!: string;

  @Field(() => String, { description: 'An openbao:// reference to the secret, never its value.' })
  readonly secretRef!: string;
}

/** A key/value label of an asset. */
@ObjectType('AssetTag', { description: 'A key/value label of an asset.' })
export class AssetTagModel {
  @Field(() => String)
  readonly key!: string;

  @Field(() => String)
  readonly value!: string;
}

/** A named group an asset belongs to. */
@ObjectType('AssetGroup', { description: 'A group of assets.' })
export class AssetGroupModel {
  @Field(() => ID)
  readonly id!: string;

  @Field(() => String)
  readonly name!: string;
}

/** An asset of the caller's tenant (the read model the console shows). Identifiers are not exposed here. */
@ObjectType('Asset', { description: 'An asset of the caller tenant.' })
export class AssetModel {
  @Field(() => ID)
  readonly id!: string;

  @Field(() => String, { description: 'The asset_ public id.' })
  readonly publicId!: string;

  @Field(() => String)
  readonly name!: string;

  @Field(() => String)
  readonly type!: string;

  @Field(() => String)
  readonly environment!: string;

  @Field(() => VerificationStatusModel)
  readonly verification!: VerificationStatusModel;

  @Field(() => AttestationSummaryModel, { nullable: true })
  readonly attestation!: AttestationSummaryModel | null;

  @Field(() => String, { description: 'ISO-8601 UTC time of creation.' })
  readonly createdAt!: string;

  @Field(() => String, { description: 'ISO-8601 UTC time of the last change.' })
  readonly updatedAt!: string;

  /** The owner's user id; the `owner` field resolves it through the membership-scoped user loader. */
  readonly ownerUserId!: string;
}

/** One keyset page of assets. `nextCursor` is passed as `cursor` for the next page; `hasMore` says whether one exists. */
@ObjectType('AssetPage', { description: 'One page of assets (newest first).' })
export class AssetPageModel {
  @Field(() => [AssetModel])
  readonly items!: readonly AssetModel[];

  @Field(() => String, { nullable: true, description: 'Pass as `cursor` for the next page.' })
  readonly nextCursor!: string | null;

  @Field(() => Boolean)
  readonly hasMore!: boolean;
}
