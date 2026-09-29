import { useState } from 'react';
import PipelineBoard from '../components/PipelineBoard';
import StageManagerModal from '../components/StageManagerModal';
import AddPipelineModal from '../components/AddPipelineModal';
import { usePermission } from '../hooks/usePermission';

// The sales pipeline: multiple boards (pipelines), one card per company (an
// Opportunity) on each. Drag a company between stages to advance its deal.
// Pipelines and their stages are editable in-app; Master is the default board.
export default function Pipeline() {
  const canEdit = usePermission('pipeline.edit');
  const [manageStagesOpen, setManageStagesOpen] = useState(false);
  const [addPipelineOpen, setAddPipelineOpen] = useState(false);

  return (
    <>
      <div className="page-head">
        <div className="page-head-text">
          <h1 className="page-head-title">Pipeline</h1>
        </div>
        {canEdit && (
          <div className="page-head-actions">
            <button type="button" className="btn btn-gold" onClick={() => setAddPipelineOpen(true)}>New pipeline</button>
            <button type="button" className="btn btn-primary" onClick={() => setManageStagesOpen(true)}>Edit stages</button>
          </div>
        )}
      </div>

      <PipelineBoard />

      <StageManagerModal open={manageStagesOpen} onClose={() => setManageStagesOpen(false)} />
      <AddPipelineModal open={addPipelineOpen} onClose={() => setAddPipelineOpen(false)} />
    </>
  );
}
