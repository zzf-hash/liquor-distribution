import { Fragment, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';

export interface PlainColumn<T> {
  title: ReactNode;
  dataIndex?: string;
  width?: number;
  align?: 'left' | 'right';
  // 单元格原值类型随列变化，和 antd columns 一样放宽。
  render?: (value: any, record: T) => ReactNode;
}

/** 首屏列表不用 antd Table。antd Table 会带上 rc-table，gzip 大约 90KB。 */
export function PlainTable<T extends { id?: string }>(props: {
  columns: Array<PlainColumn<T>>;
  dataSource: T[];
  loading?: boolean;
  emptyText?: string;
  pagination?: {
    current: number;
    pageSize: number;
    total: number;
    onChange: (page: number, pageSize: number) => void;
  };
  expandable?: { expandedRowRender: (record: T) => ReactNode };
}): JSX.Element {
  const dataSource = props.dataSource ?? [];
  const [open, setOpen] = useState<string | null>(null);
  const cell: CSSProperties = { padding: '8px 12px', borderBottom: '1px solid #f0f0f0', verticalAlign: 'top' };
  return (
    <div>
      {props.loading ? <div style={{ padding: 12, color: '#8c8c8c' }}>加载中</div> : null}
      <table style={{ width: '100%', borderCollapse: 'collapse', background: '#fff' }}>
        <thead>
          <tr>
            {props.expandable ? <th style={{ ...cell, width: 32 }} /> : null}
            {props.columns.map((col) => (
              <th key={String(col.title)} style={{ ...cell, width: col.width, textAlign: col.align ?? 'left', fontWeight: 600 }}>
                {col.title}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {dataSource.length === 0 && !props.loading ? (
            <tr>
              <td style={cell} colSpan={props.columns.length + (props.expandable ? 1 : 0)}>
                {props.emptyText ?? '暂无数据'}
              </td>
            </tr>
          ) : dataSource.map((row, index) => {
            const key = row.id ?? String(index);
            const expanded = open === key;
            return (
              <Fragment key={key}>
                <tr>
                  {props.expandable ? (
                    <td style={cell}>
                      <button type="button" onClick={() => setOpen(expanded ? null : key)} style={{ border: 0, background: 'transparent', cursor: 'pointer' }}>
                        {expanded ? '▾' : '▸'}
                      </button>
                    </td>
                  ) : null}
                  {props.columns.map((col) => {
                    const value = col.dataIndex ? (row as Record<string, unknown>)[col.dataIndex] : undefined;
                    return (
                      <td key={String(col.title)} style={{ ...cell, textAlign: col.align ?? 'left' }}>
                        {col.render ? col.render(value, row) : (value as ReactNode)}
                      </td>
                    );
                  })}
                </tr>
                {expanded && props.expandable ? (
                  <tr>
                    <td style={cell} colSpan={props.columns.length + 1}>{props.expandable.expandedRowRender(row)}</td>
                  </tr>
                ) : null}
              </Fragment>
            );
          })}
        </tbody>
      </table>
      {props.pagination ? (
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 12 }}>
          <button type="button" disabled={props.pagination.current <= 1} onClick={() => props.pagination?.onChange(props.pagination.current - 1, props.pagination.pageSize)}>上一页</button>
          <span>{props.pagination.current} / {Math.max(1, Math.ceil(props.pagination.total / props.pagination.pageSize))}（共 {props.pagination.total} 条）</span>
          <button
            type="button"
            disabled={props.pagination.current >= Math.ceil(props.pagination.total / props.pagination.pageSize)}
            onClick={() => props.pagination?.onChange(props.pagination.current + 1, props.pagination.pageSize)}
          >
            下一页
          </button>
          <select
            value={props.pagination.pageSize}
            onChange={(e) => props.pagination?.onChange(1, Number(e.target.value))}
          >
            {[10, 20, 50].map((size) => <option key={size} value={size}>{size} 条/页</option>)}
          </select>
        </div>
      ) : null}
    </div>
  );
}

export function Panel(props: { title?: ReactNode; extra?: ReactNode; children: ReactNode; style?: CSSProperties }): JSX.Element {
  return (
    <div style={{ background: '#fff', border: '1px solid #f0f0f0', borderRadius: 8, padding: 16, marginBottom: 16, ...props.style }}>
      {(props.title || props.extra) ? (
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 12, fontWeight: 600 }}>
          <span>{props.title}</span>
          <span>{props.extra}</span>
        </div>
      ) : null}
      {props.children}
    </div>
  );
}
