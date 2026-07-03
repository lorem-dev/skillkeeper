import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import { FormSection } from './FormSection';
import { FormRow } from './FormRow';
import { Toggle } from '../Toggle';
import { Select } from '../Select';
import { Stepper } from '../Stepper';

const meta = {
  title: 'shared/ui/Form',
  component: FormSection,
  // children is required; the render below provides the rows.
  args: { children: null },
} satisfies Meta<typeof FormSection>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Settings: Story = {
  render: () => {
    const [hooks, setHooks] = useState(true);
    const [lang, setLang] = useState('en');
    const [retries, setRetries] = useState(3);
    return (
      <div style={{ width: 420 }}>
        <FormSection title="General" footer="These settings apply to every project.">
          <FormRow label="Enable hooks" description="Ask before installing hooks">
            <Toggle checked={hooks} onChange={(e) => setHooks(e.target.checked)} />
          </FormRow>
          <FormRow label="Language">
            <Select
              value={lang}
              onChange={setLang}
              options={[
                { value: 'en', label: 'English' },
                { value: 'de', label: 'Deutsch' },
                { value: 'ru', label: 'Russian' },
              ]}
            />
          </FormRow>
          <FormRow label="Install retries">
            <Stepper value={retries} onChange={setRetries} min={0} max={9} />
          </FormRow>
        </FormSection>
      </div>
    );
  },
};
