import { Button, CellList, CellSimple } from '@maxhub/max-ui';
import type { RequestItem } from '../api';
import { shortDate } from '../format';
import { StatusPill } from '../ui';

export function Requests(props: { items: RequestItem[]; onOpen: (id: string) => void; onNew: () => void }) {
  if (props.items.length === 0) {
    return (
      <div className="state" style={{ minHeight: '60dvh', background: 'transparent' }}>
        <h1>Заявок пока нет</h1>
        <p>Опишите проблему и приложите фото — мы назовём, кто отвечает и в какой срок по закону должны отреагировать.</p>
        <Button size="large" onClick={props.onNew}>
          Подать заявку
        </Button>
      </div>
    );
  }
  const open = props.items.filter((r) => r.can_cancel).length;
  return (
    <div className="stack">
      <div className="gutter">
        <Button size="large" stretched onClick={props.onNew}>
          Подать заявку
        </Button>
      </div>
      <CellList mode="island" filled header={<span className="note" style={{ margin: 0 }}>{open ? `Открытых: ${open}` : 'Все заявки закрыты'}</span>}>
        {props.items.map((r) => (
          <CellSimple
            key={r.id}
            as="button"
            onClick={() => props.onOpen(r.id)}
            overline={`${r.number} · ${shortDate(r.created_at)}`}
            title={r.category_title}
            subtitle={r.description}
            after={<StatusPill r={r} />}
            showChevron
          />
        ))}
      </CellList>
    </div>
  );
}
