import { Button, CellList, CellSimple } from '@maxhub/max-ui';
import type { RequestItem } from '../api';
import { shortDate } from '../format';
import { StatusPill } from '../ui';

export function Requests(props: { items: RequestItem[]; onOpen: (id: string) => void; onWriteBot: () => void }) {
  if (props.items.length === 0) {
    return (
      <div className="state">
        <h1>Заявок пока нет</h1>
        <p>Опишите проблему боту в чате одним сообщением — например, «Течёт батарея в комнате». Бот оформит заявку и назовёт срок.</p>
        <Button size="medium" onClick={props.onWriteBot}>
          Написать боту
        </Button>
      </div>
    );
  }
  const open = props.items.filter((r) => r.can_cancel).length;
  return (
    <div className="stack">
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
      <p className="note">Новую заявку подают в чате: просто опишите проблему боту.</p>
    </div>
  );
}
