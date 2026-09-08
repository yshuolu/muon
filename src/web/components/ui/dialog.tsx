import * as DialogPrimitive from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '../../lib/utils';

export function Dialog({ open, onOpenChange, title, description, children, className }: {
  open: boolean; onOpenChange: (open: boolean) => void; title: string;
  description?: string; children: ReactNode; className?: string;
}) {
  return <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className="dialog-overlay" />
      <DialogPrimitive.Content className={cn('dialog-content', className)}>
        <div className="dialog-heading"><DialogPrimitive.Title>{title}</DialogPrimitive.Title>
          <DialogPrimitive.Close className="button button-ghost button-icon" aria-label="Close dialog"><X size={17} /></DialogPrimitive.Close>
        </div>
        <DialogPrimitive.Description className={description ? 'dialog-description' : 'sr-only'}>{description || title}</DialogPrimitive.Description>
        {children}
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  </DialogPrimitive.Root>;
}
