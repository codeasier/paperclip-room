import { Avatar } from 'antd';

const roles: Record<string, [string, string]> = {
  PL: ['项目负责人', 'PL'],
  Analyst: ['需求分析', 'AN'],
  Designer: ['交互设计', 'UX'],
  Architect: ['架构师', 'AR'],
  Frontend: ['前端开发', 'FE'],
  Backend: ['后端开发', 'BE'],
  QA: ['质量测试', 'QA'],
  DevOps: ['持续交付', 'CI'],
};

export function roleLabel(name: string, title?: string) {
  return roles[name]?.[0] || title || '团队成员';
}

export function MemberAvatar({
  name,
  size = 34,
  status,
}: {
  name: string;
  size?: number;
  status?: string;
}) {
  let hue = 0;
  for (let i = 0; i < name.length; i++) hue = (hue * 31 + name.charCodeAt(i)) % 360;
  return (
    <span className="avatar-wrap" aria-hidden="true">
      <Avatar
        className="member-avatar"
        shape="square"
        size={size}
        style={{
          background: `hsl(${hue} 55% 94%)`,
          color: `hsl(${hue} 35% 35%)`,
          fontSize: size >= 34 ? 11.5 : 10,
        }}
      >
        {roles[name]?.[1] || name.slice(0, 1).toUpperCase() || '?'}
      </Avatar>
      {status && <span className={`avatar-ring ${status}`} />}
    </span>
  );
}
