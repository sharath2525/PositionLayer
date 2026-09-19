'use client';
import { useEffect, useId, useRef } from 'react';
import { X } from 'lucide-react';

export function Modal({ title, children, onClose, className = '' }: { title: string; children: React.ReactNode; onClose: () => void; className?: string }) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const dialog = ref.current;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialog?.showModal();
    dialog?.querySelector<HTMLButtonElement>('button')?.focus({ preventScroll: true });
    return () => {
      dialog?.close();
      previousFocus?.focus({ preventScroll: true });
    };
  }, []);
  return <dialog ref={ref} className={`modal ${className}`} aria-labelledby={titleId} onKeyDown={event=>{
    if(event.key!=='Tab')return;
    const controls=Array.from(event.currentTarget.querySelectorAll<HTMLElement>('button:not([disabled]),a[href],input:not([disabled]),select:not([disabled]),textarea:not([disabled]),summary,[tabindex]:not([tabindex="-1"])')).filter(el=>el.getClientRects().length>0);
    const first=controls[0],last=controls.at(-1);
    if(event.shiftKey&&document.activeElement===first){event.preventDefault();last?.focus();}
    else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first?.focus();}
  }} onCancel={onClose} onClick={event => { if (event.target === event.currentTarget) onClose(); }}><div className="modal-inner"><div className="modal-title"><h2 id={titleId}>{title}</h2><button className="icon-button" aria-label="Close dialog" onClick={onClose}><X size={20}/></button></div>{children}</div></dialog>;
}
