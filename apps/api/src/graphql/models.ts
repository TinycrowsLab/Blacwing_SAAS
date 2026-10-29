import { Field, ID, Int, ObjectType } from '@nestjs/graphql';

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

/** A reference to an asset under test. Asset records are read through their own module; this type names them. */
@ObjectType('AssetRef', { description: 'An asset under test, by id.' })
export class AssetRefModel {
  @Field(() => ID)
  readonly id!: string;
}

/** A reference to a standing authorisation (SA). */
@ObjectType('SARef', { description: 'A standing authorisation, by id.' })
export class SARefModel {
  @Field(() => ID)
  readonly id!: string;
}

/** An assessment request (SCOPE-001) as the console reads it. Status and mode are the contract's string values. */
@ObjectType('AssessmentRequest', { description: 'A scoping-form request in the caller tenant.' })
export class AssessmentRequestModel {
  @Field(() => ID)
  readonly id!: string;

  @Field(() => String)
  readonly publicId!: string;

  @Field(() => String, { description: 'Run mode (contract RUN_MODES).' })
  readonly mode!: string;

  @Field(() => String, { description: 'draft, submitted, withdrawn, promoted or rejected.' })
  readonly status!: string;

  @Field(() => String)
  readonly objective!: string;

  @Field(() => [ID], { description: 'Ids of the assets under test.' })
  readonly assetIds!: readonly string[];

  @Field(() => ID, { nullable: true })
  readonly saId!: string | null;

  @Field(() => ID, { nullable: true })
  readonly inputManifestId!: string | null;

  @Field(() => String)
  readonly maxIntrusiveness!: string;

  @Field(() => ID, { description: 'The user who created the request.' })
  readonly requestedBy!: string;

  @Field(() => String, { description: 'ISO-8601 UTC.' })
  readonly createdAt!: string;

  @Field(() => String, { description: 'ISO-8601 UTC.' })
  readonly updatedAt!: string;
}

/** One request of a connection page, with the opaque cursor that resumes after it. */
@ObjectType('AssessmentRequestEdge')
export class AssessmentRequestEdgeModel {
  @Field(() => String)
  readonly cursor!: string;

  @Field(() => AssessmentRequestModel)
  readonly node!: AssessmentRequestModel;
}

/** Relay page information. */
@ObjectType('PageInfo')
export class PageInfoModel {
  @Field(() => Boolean)
  readonly hasNextPage!: boolean;

  @Field(() => String, { nullable: true })
  readonly endCursor!: string | null;
}

/** A page of assessment requests (Relay connection). */
@ObjectType('AssessmentRequestConnection')
export class AssessmentRequestConnectionModel {
  @Field(() => [AssessmentRequestEdgeModel])
  readonly edges!: readonly AssessmentRequestEdgeModel[];

  @Field(() => PageInfoModel)
  readonly pageInfo!: PageInfoModel;
}

/** How many nodes or relationships of one kind a run holds. */
@ObjectType('KindCount', { description: 'How many of one kind a run holds.' })
export class KindCountModel {
  @Field(() => String)
  readonly kind!: string;

  @Field(() => Int)
  readonly count!: number;
}

/** A technology of a run, with how many services run it. */
@ObjectType('TechnologyCount', {
  description: 'A technology of a run and how many services run it.',
})
export class TechnologyCountModel {
  @Field(() => String)
  readonly name!: string;

  @Field(() => Int)
  readonly count!: number;
}

/** The surface of one run, as the console dashboard tiles read it (point-in-time per request). */
@ObjectType('SurfaceSummary', { description: 'The surface graph of one run.' })
export class SurfaceSummaryModel {
  @Field(() => ID)
  readonly runId!: string;

  @Field(() => [KindCountModel], { description: 'Nodes per kind (every kind, zero when absent).' })
  readonly nodeCounts!: readonly KindCountModel[];

  @Field(() => [KindCountModel], {
    description: 'Relationships per kind (every kind, zero when absent).',
  })
  readonly edgeCounts!: readonly KindCountModel[];

  @Field(() => [TechnologyCountModel], {
    description: 'Most widely run technologies, most frequent first.',
  })
  readonly topTechnologies!: readonly TechnologyCountModel[];

  @Field(() => Int)
  readonly endpointCount!: number;

  @Field(() => Int, {
    description: 'Endpoints that a service on an in-scope host serves.',
  })
  readonly inScopeEndpointCount!: number;
}

/** An endpoint of the surface graph (contract `endpoint` node, without its tenant). */
@ObjectType('Endpoint', { description: 'An endpoint discovered for a run.' })
export class EndpointModel {
  @Field(() => String)
  readonly method!: string;

  @Field(() => String)
  readonly pathTemplate!: string;

  @Field(() => ID, { description: 'The asset the endpoint belongs to.' })
  readonly assetId!: string;

  @Field(() => String, { nullable: true })
  readonly baseUrl!: string | null;

  @Field(() => Boolean)
  readonly authRequired!: boolean;

  @Field(() => [String])
  readonly contentTypes!: readonly string[];
}

/** One endpoint of a page, with the opaque cursor that resumes after it. */
@ObjectType('EndpointEdge')
export class EndpointEdgeModel {
  @Field(() => String)
  readonly cursor!: string;

  @Field(() => EndpointModel)
  readonly node!: EndpointModel;
}

/** A page of a run's endpoints (Relay connection). */
@ObjectType('EndpointConnection', { description: 'A page of the endpoints of a run.' })
export class EndpointConnectionModel {
  @Field(() => [EndpointEdgeModel])
  readonly edges!: readonly EndpointEdgeModel[];

  @Field(() => PageInfoModel)
  readonly pageInfo!: PageInfoModel;
}
