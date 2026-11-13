import { createFileRoute } from "@tanstack/react-router";
import {
  ActionButton,
  Button,
  ButtonSet,
  Card,
  CountTile,
  CountTiles,
  DataTable,
  DetailHeader,
  EmptyState,
  Facts,
  Funnel,
  Grid,
  Link,
  NextSteps,
  RelativeDate,
  Section,
  SectionCard,
  Split,
  Stack,
  StatusTag,
  StepList,
  TilesSkeleton,
  TrackBar,
  type DataColumn,
} from "@transfer/ui";
import { kit, kitToday } from "../components/ui-kit-fixtures";
import { usePageTitle } from "../page-title";

export const Route = createFileRoute("/ui-kit")({ component: UiKit });

type Row = (typeof kit.table.rows)[number];

const columns: DataColumn<Row>[] = [
  {
    key: "name",
    header: kit.table.columns.name,
    render: (row) => `${row.name} · ${row.personnelNumber}`,
    sortValue: (row) => row.name,
    alwaysVisible: true,
  },
  { key: "step", header: kit.table.columns.step, render: (row) => row.step },
  {
    key: "due",
    header: kit.table.columns.due,
    render: (row) => <RelativeDate date={row.due} today={kitToday} kind="deadline" />,
    sortValue: (row) => row.due,
  },
  {
    key: "consultant",
    header: kit.table.columns.consultant,
    render: (row) => row.consultant,
    sortValue: (row) => row.consultant,
  },
];

const noop = () => {};

/** The kit's table on the fixed rows: with its filter, its column chooser and its states. */
const table = (title: string, extra: { loading?: boolean; items?: Row[] } = {}) => (
  <DataTable
    title={title}
    items={extra.items ?? kit.table.rows}
    loading={extra.loading}
    columns={columns}
    rowLabel={(row) => row.personnelNumber}
    columnChooser
    filter={{
      label: kit.table.filter,
      text: (row) => `${row.name} ${row.personnelNumber}`,
      renderNoMatches: (reset) => (
        <EmptyState variant="noMatches" title={kit.table.noMatches} onResetFilters={reset} />
      ),
    }}
    emptyState={
      <EmptyState
        variant="noData"
        title={kit.table.emptyState}
        description={kit.table.emptyDescription}
      />
    }
  />
);

/**
 * The kit page (ui-patterns.md, testing): every component of the kit's second layer in its
 * states, on fixed synthetic fixtures. Reached by its address only; it reads no data, and
 * ui-kit.spec.ts and the pixel comparison run against it.
 */
function UiKit() {
  usePageTitle(kit.title);
  return (
    <>
      <DetailHeader
        title={kit.title}
        breadcrumbs={[
          <Link key="projects" href="/projects">
            {kit.crumb}
          </Link>,
        ]}
        metadata={kit.metadata}
        tags={
          <>
            <StatusTag family="main" code="informed" />
            <StatusTag family="profiling" code="profiling_in_progress" />
            <StatusTag family="dsv" code="dsv_offered" />
          </>
        }
        facts={kit.headerFacts}
        primaryAction={<Button onClick={noop}>{kit.primary}</Button>}
        menuActions={kit.menu.map((label, index) => ({
          label,
          onClick: noop,
          danger: index === kit.menu.length - 1,
        }))}
      />
      <Stack gap={7}>
        <Section title={kit.sections.tiles}>
          <Stack gap={5}>
            <CountTiles>
              {kit.tiles.map((tile) => (
                <CountTile
                  key={tile.label}
                  {...tile}
                  renderLink={({ className, children }) => (
                    <a href="#tiles" className={className}>
                      {children}
                    </a>
                  )}
                />
              ))}
            </CountTiles>
            <TilesSkeleton label={kit.loading} />
          </Stack>
        </Section>
        <Section title={kit.sections.funnel}>
          <Funnel
            label={kit.funnel.label}
            stages={kit.funnel.stages.map((stage, index) => ({
              ...stage,
              // The first stages as links, the last as text: both states.
              ...(index < 5 && {
                renderLink: ({ className, children }) => (
                  <a href="#funnel" className={className}>
                    {children}
                  </a>
                ),
              }),
            }))}
          />
        </Section>
        <Section title={kit.sections.nextSteps}>
          <Grid columns={2}>
            <NextSteps
              title={kit.nextSteps.title}
              level={3}
              summary={kit.nextSteps.summary}
              emptyText={kit.nextSteps.empty}
              more={<Link href="#next-steps">{kit.nextSteps.more}</Link>}
              items={kit.nextSteps.items.map(({ action, ...item }) => ({
                ...item,
                action: (
                  <Button kind="tertiary" size="sm" onClick={noop}>
                    {action}
                  </Button>
                ),
              }))}
            />
            <NextSteps
              title={kit.nextSteps.emptyTitle}
              level={3}
              emptyText={kit.nextSteps.empty}
              items={[]}
            />
          </Grid>
        </Section>
        <Section title={kit.sections.sectionCard}>
          <Stack gap={5}>
            <SectionCard
              title={kit.cards.open.title}
              level={3}
              defaultOpen
              actions={
                <Button kind="ghost" size="sm" onClick={noop}>
                  {kit.cards.open.action}
                </Button>
              }
            >
              <Facts items={kit.facts} />
            </SectionCard>
            <SectionCard
              title={kit.cards.collapsed.title}
              level={3}
              summary={kit.cards.collapsed.summary}
            >
              <p>{kit.cards.body}</p>
            </SectionCard>
            <SectionCard
              title={kit.cards.protected.title}
              level={3}
              summary={kit.cards.protected.summary}
              defaultOpen
              protectedContent
            >
              <p>{kit.cards.protected.body}</p>
            </SectionCard>
          </Stack>
        </Section>
        <Section title={kit.sections.facts}>
          <Facts items={kit.facts} columns={4} labels="above" />
        </Section>
        <Section title={kit.sections.stepList}>
          <StepList
            label={kit.steps.label}
            steps={kit.steps.items.map((step) => ({
              ...step,
              children: (
                <Stack gap={5}>
                  <p>{kit.steps.body}</p>
                  {step.state === "current" && (
                    <div>
                      <Button kind="tertiary" onClick={noop}>
                        {kit.steps.action}
                      </Button>
                    </div>
                  )}
                </Stack>
              ),
            }))}
          />
        </Section>
        <Section title={kit.sections.trackBar}>
          <Card title={kit.sections.trackBar} level={3}>
            {kit.tracks.map((track) => (
              <TrackBar
                key={track.title}
                title={track.title}
                steps={track.steps}
                current={track.current}
                tag={
                  track.family === "main" ? (
                    <StatusTag family="main" code={track.code} />
                  ) : track.family === "profiling" ? (
                    <StatusTag family="profiling" code={track.code} />
                  ) : (
                    <StatusTag family="dsv" code={track.code} />
                  )
                }
              >
                {track.detail}
              </TrackBar>
            ))}
          </Card>
        </Section>
        <Section title={kit.sections.split}>
          <Split side={<Card title={kit.split.side} level={3} />}>
            <Card title={kit.split.main} level={3} />
          </Split>
        </Section>
        <Section title={kit.sections.dataTable}>
          <Stack gap={5}>
            {table(kit.table.title)}
            {table(kit.table.loadingTitle, { loading: true })}
            {table(kit.table.emptyTitle, { items: [] })}
          </Stack>
        </Section>
        <Section title={kit.sections.buttons}>
          <ButtonSet>
            <Button onClick={noop}>{kit.buttons.primary}</Button>
            <Button kind="tertiary" onClick={noop}>
              {kit.buttons.tertiary}
            </Button>
            <Button kind="ghost" onClick={noop}>
              {kit.buttons.ghost}
            </Button>
            <Button kind="danger--tertiary" onClick={noop}>
              {kit.buttons.danger}
            </Button>
            <ActionButton kind="tertiary" unavailableReason={kit.buttons.unavailableReason}>
              {kit.buttons.unavailable}
            </ActionButton>
          </ButtonSet>
        </Section>
      </Stack>
    </>
  );
}
