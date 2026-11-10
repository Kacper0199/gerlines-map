import { TrainDetail } from "@gerlines/schema";

export interface FixtureInfo {
  readonly name: string;
  readonly note: string;
  readonly database: string;
  readonly asOf: string;
  readonly selection: string;
  readonly replay: {
    readonly from: string | null;
    readonly to: string | null;
    readonly note?: string;
  };
  readonly feedVersions: readonly { readonly id: number; readonly version: string }[];
  readonly rtPayloads: {
    readonly atOrBefore: string;
    readonly total: number;
    readonly bySource: Readonly<Record<string, number>>;
    readonly countedAt?: string;
  };
  readonly builder: {
    readonly script: string;
    readonly commit: string | null;
    readonly sha256: string;
  };
  readonly assumed: readonly string[];
  readonly rebuildable: boolean;
  readonly rebuildNote: string;
}

export interface TrainFixture {
  readonly fixture: FixtureInfo;
  readonly detail: TrainDetail;
}

const files = import.meta.glob<{ default: { fixture: FixtureInfo; detail: unknown } }>("./*.json", {
  eager: true,
});

export const TRAIN_FIXTURES: Readonly<Record<string, TrainFixture>> = Object.fromEntries(
  Object.values(files).map(({ default: file }) => [
    file.fixture.name,
    { fixture: file.fixture, detail: TrainDetail.parse(file.detail) },
  ]),
);
