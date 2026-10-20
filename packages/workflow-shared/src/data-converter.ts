import { defaultDataConverter, type DataConverter, type PayloadCodec } from '@temporalio/common';

/**
 * Options for {@link createDataConverter}.
 */
export interface DataConverterOptions {
  /**
   * Payload codec applied to every payload on its way to and from Temporal. This is the extension
   * point for payload encryption (PII never reaches the Temporal history in plaintext). Unset means
   * the SDK default: payloads are stored as plain JSON/binary.
   */
  readonly payloadCodec?: PayloadCodec;
}

/**
 * Builds the {@link DataConverter} every Blackwing Temporal client and worker must share. Today it is the
 * SDK default converter; a payload codec (encryption) is slotted in through `payloadCodec` without any
 * call site changing. Clients and workers must be given the same converter or payloads cannot be read back.
 */
export function createDataConverter(options: DataConverterOptions = {}): DataConverter {
  if (options.payloadCodec === undefined) return defaultDataConverter;
  return { ...defaultDataConverter, payloadCodecs: [options.payloadCodec] };
}
