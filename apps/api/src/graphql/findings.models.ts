import { Field, Float, ID, InputType, Int, ObjectType } from '@nestjs/graphql';

/** Filters of the `findings` query. Each one narrows the list; they combine with AND. Values are validated by the service. */
@InputType('FindingFilter', { description: 'Filters of the findings list (combined with AND).' })
export class FindingFilterModel {
  @Field(() => ID, { nullable: true })
  readonly assetId?: string;

  @Field(() => String, { nullable: true, description: 'A finding status, for example confirmed.' })
  readonly status?: string;

  @Field(() => String, {
    nullable: true,
    description: 'CVSS v4.0 band: none, low, medium, high or critical.',
  })
  readonly severity?: string;

  @Field(() => String, {
    nullable: true,
    description: 'A CWE id from the pinned list, for example CWE-89.',
  })
  readonly cwe?: string;

  @Field(() => String, {
    nullable: true,
    description: 'An OWASP Top 10 2021 category, A01 to A10.',
  })
  readonly owasp?: string;

  @Field(() => String, {
    nullable: true,
    description: 'Baseline status: new, open, fixed, returned or not_retested.',
  })
  readonly baselineStatus?: string;
}

/** The CVSS v4.0 score of a finding, as its vector computes it. */
@ObjectType('Cvss4Score', { description: 'CVSS v4.0 score, band and nomenclature of a finding.' })
export class Cvss4ScoreModel {
  @Field(() => String)
  readonly vector!: string;

  @Field(() => Float)
  readonly score!: number;

  @Field(() => String, { description: 'none, low, medium, high or critical.' })
  readonly severity!: string;

  @Field(() => String, { description: 'CVSS-B, CVSS-BE, CVSS-BT or CVSS-BTE.' })
  readonly nomenclature!: string;
}

/** The severity of a finding. Null until the validator scores it. */
@ObjectType('FindingSeverity', {
  description: 'Severity of a finding (CVSS v4.0 is authoritative).',
})
export class FindingSeverityModel {
  @Field(() => Cvss4ScoreModel)
  readonly cvss4!: Cvss4ScoreModel;
}

/** Where a finding is: the HTTP method and URL template, the parameter, and the file and line for white box. */
@ObjectType('FindingLocation', { description: 'Where the finding is.' })
export class FindingLocationModel {
  @Field(() => String, { nullable: true })
  readonly method!: string | null;

  @Field(() => String, { nullable: true })
  readonly urlTemplate!: string | null;

  @Field(() => String, { nullable: true })
  readonly parameter!: string | null;

  @Field(() => String, { nullable: true })
  readonly file!: string | null;

  @Field(() => Int, { nullable: true })
  readonly line!: number | null;
}

/** One run's sighting of a finding. */
@ObjectType('FindingOccurrence', { description: 'One run that observed a finding.' })
export class FindingOccurrenceModel {
  @Field(() => ID)
  readonly id!: string;

  @Field(() => ID)
  readonly runId!: string;

  @Field(() => String)
  readonly occurrenceStatus!: string;

  @Field(() => String, { nullable: true, description: 'Head of the evidence chain (SHA-256 hex).' })
  readonly evidenceChainHead!: string | null;

  @Field(() => String, { description: 'ISO-8601 UTC.' })
  readonly detectedAt!: string;
}

/** One bound evidence reference of an occurrence, in chain order. References only, never the bytes. */
@ObjectType('FindingEvidenceRef', { description: 'A bound evidence reference of an occurrence.' })
export class FindingEvidenceRefModel {
  @Field(() => ID)
  readonly occurrenceId!: string;

  @Field(() => ID)
  readonly runId!: string;

  @Field(() => ID)
  readonly evidenceId!: string;

  @Field(() => String)
  readonly objectKey!: string;

  @Field(() => String)
  readonly sha256!: string;

  @Field(() => String)
  readonly chain!: string;
}

/** A bounded slice of occurrences: the first `items`, the full `total`, and whether `items` is a prefix. */
@ObjectType('FindingOccurrences', { description: 'Occurrences of a finding, capped per page.' })
export class FindingOccurrencesModel {
  @Field(() => [FindingOccurrenceModel])
  readonly items!: readonly FindingOccurrenceModel[];

  @Field(() => Int)
  readonly total!: number;

  @Field(() => Boolean)
  readonly truncated!: boolean;
}

/** A bounded slice of evidence refs. */
@ObjectType('FindingEvidence', { description: 'Evidence refs of a finding, capped per page.' })
export class FindingEvidenceModel {
  @Field(() => [FindingEvidenceRefModel])
  readonly items!: readonly FindingEvidenceRefModel[];

  @Field(() => Int)
  readonly total!: number;

  @Field(() => Boolean)
  readonly truncated!: boolean;
}

/**
 * A finding as the console reads it. `id` is the `fnd_…` public id. The row id is kept off the schema: it only
 * keys the occurrence DataLoader, so the nested fields batch per request.
 */
@ObjectType('Finding', { description: 'A finding of the caller tenant (read-only).' })
export class FindingModel {
  @Field(() => ID)
  readonly id!: string;

  @Field(() => String)
  readonly title!: string;

  @Field(() => String)
  readonly class!: string;

  @Field(() => String, { description: 'Finding status (contract FINDING statuses).' })
  readonly status!: string;

  @Field(() => String, { nullable: true })
  readonly baselineStatus!: string | null;

  @Field(() => FindingSeverityModel, { nullable: true })
  readonly severity!: FindingSeverityModel | null;

  @Field(() => String, { nullable: true })
  readonly cweId!: string | null;

  @Field(() => String, { nullable: true })
  readonly owaspCategory!: string | null;

  @Field(() => Boolean)
  readonly unmapped!: boolean;

  @Field(() => Float, { nullable: true })
  readonly confidence!: number | null;

  @Field(() => ID)
  readonly assetId!: string;

  @Field(() => FindingLocationModel)
  readonly location!: FindingLocationModel;

  @Field(() => ID)
  readonly firstSeenRunId!: string;

  @Field(() => ID)
  readonly lastSeenRunId!: string;

  @Field(() => Int)
  readonly stateVersion!: number;

  @Field(() => String)
  readonly createdAt!: string;

  @Field(() => String)
  readonly updatedAt!: string;

  /** The row id (UUIDv7). Not part of the schema. */
  readonly rowId!: string;
}

/** A page of findings (cursor pagination, the same cursor the REST list uses). */
@ObjectType('FindingConnection', { description: 'A page of findings, newest first.' })
export class FindingConnectionModel {
  @Field(() => [FindingModel])
  readonly items!: readonly FindingModel[];

  @Field(() => String, { nullable: true, description: 'Pass as `after` for the next page.' })
  readonly nextCursor!: string | null;

  @Field(() => Boolean)
  readonly hasMore!: boolean;
}
