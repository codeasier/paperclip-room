import { useRef } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Alert, App, Form, Input, Modal, Select } from 'antd';
import { apiUrl, postJSON } from '../../api/client';

interface Values {
  title: string;
  description?: string;
  priority: string;
}
export function CreateTaskModal({
  company,
  agentId,
  agentName,
  onClose,
  onCreated,
}: {
  company: string;
  agentId: string;
  agentName: string;
  onClose: () => void;
  onCreated: () => void;
}) {
  const [form] = Form.useForm<Values>();
  const { message } = App.useApp();
  const client = useQueryClient();
  const lock = useRef(false);
  const mutation = useMutation({
    mutationFn: (values: Values) => postJSON(apiUrl('/api/tasks', company), { ...values, agentId }),
    onSuccess: (result) => {
      void message.success(`任务 ${result.issue || ''} 已创建`);
      void client.invalidateQueries({ predicate: (query) => query.queryKey[1] === company });
      onCreated();
      onClose();
    },
  });
  return (
    <Modal
      open
      title="新建任务"
      centered
      width={520}
      okText="创建任务"
      cancelText="取消"
      confirmLoading={mutation.isPending}
      closable={!mutation.isPending}
      maskClosable={false}
      cancelButtonProps={{ disabled: mutation.isPending, 'aria-label': '取消' }}
      onCancel={onClose}
      onOk={() => form.submit()}
    >
      <Form
        form={form}
        layout="vertical"
        requiredMark={false}
        initialValues={{ priority: 'medium' }}
        onFinish={async (values) => {
          if (lock.current) return;
          lock.current = true;
          try {
            await mutation.mutateAsync(values);
          } catch {
            /* keep form and show error */
          } finally {
            lock.current = false;
          }
        }}
      >
        {mutation.isError && (
          <Alert type="error" showIcon title={mutation.error.message} className="section-gap" />
        )}
        <Form.Item
          name="title"
          label="标题"
          rules={[{ required: true, whitespace: true, message: '请输入任务标题' }]}
        >
          <Input aria-label="任务标题" maxLength={200} autoFocus placeholder="一句话说明要做什么" />
        </Form.Item>
        <Form.Item name="description" label="描述">
          <Input.TextArea rows={5} maxLength={20000} placeholder="背景、范围、验收标准…" />
        </Form.Item>
        <div className="task-form-row">
          <Form.Item name="priority" label="优先级">
            <Select
              options={[
                { value: 'low', label: '低' },
                { value: 'medium', label: '中' },
                { value: 'high', label: '高' },
                { value: 'critical', label: '紧急' },
              ]}
            />
          </Form.Item>
          <div className="task-assignee">
            <span>指派给</span>
            <strong>{agentName}</strong>
          </div>
        </div>
        <p className="modal-note">创建后会进入该成员的任务列表并唤醒成员；不会自动创建对话消息。</p>
      </Form>
    </Modal>
  );
}
