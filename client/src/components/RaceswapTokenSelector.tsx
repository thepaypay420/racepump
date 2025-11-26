import { useState, useMemo, type ReactNode } from "react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem } from "@/components/ui/command";
import { Button } from "@/components/ui/button";
import { Check, ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";

export interface TokenOption {
  address: string;
  symbol: string;
  name: string;
  logoURI?: string;
  decimals: number;
}

interface TokenSelectorProps {
  label: string;
  labelExtra?: ReactNode;
  value?: TokenOption | null;
  tokens: TokenOption[];
  onSelect: (token: TokenOption) => void;
  disabled?: boolean;
}

export function RaceswapTokenSelector({ label, labelExtra, value, tokens, onSelect, disabled }: TokenSelectorProps) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");

  const filteredTokens = useMemo(() => {
    const term = search.trim().toLowerCase();
    if (!term) return tokens.slice(0, 200);
    return tokens.filter((token) => {
      return (
        token.symbol.toLowerCase().includes(term) ||
        token.name.toLowerCase().includes(term) ||
        token.address.toLowerCase().includes(term)
      );
    });
  }, [tokens, search]);

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2 text-xs uppercase tracking-wide text-muted-foreground">
        <span>{label}</span>
        {labelExtra ? <span className="text-[10px] font-medium normal-case text-muted-foreground/90">{labelExtra}</span> : null}
      </div>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            variant="outline"
            role="combobox"
            disabled={disabled}
            className={cn(
              "justify-between h-14 w-full bg-card/40 hover:bg-card/60 border-border/60 text-left",
              !value && "text-muted-foreground"
            )}
          >
            <div className="flex items-center gap-3 truncate">
              {value?.logoURI ? (
                <img src={value.logoURI} alt={value.symbol} className="w-8 h-8 rounded-full object-cover border border-border/50" />
              ) : (
                <div className="w-8 h-8 rounded-full bg-muted flex items-center justify-center text-xs font-semibold">
                  {value?.symbol?.slice(0, 2) ?? "??"}
                </div>
              )}
              <div className="flex flex-col leading-tight">
                <span className="font-semibold">{value?.symbol ?? "Select token"}</span>
                <span className="text-xs text-muted-foreground truncate">{value?.name ?? "Choose any Jupiter token"}</span>
              </div>
            </div>
            <ChevronDown className="ml-2 h-4 w-4 opacity-70" />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="p-0 w-80" align="start">
          <Command className="rounded-lg border border-border">
            <CommandInput
              placeholder="Search token..."
              value={search}
              onValueChange={setSearch}
              className="placeholder:text-muted-foreground"
            />
            <CommandEmpty>No tokens found.</CommandEmpty>
            <CommandGroup className="max-h-64 overflow-y-auto">
              {filteredTokens.map((token) => (
                <CommandItem
                  key={token.address}
                  value={token.address}
                  onSelect={() => {
                    onSelect(token);
                    setOpen(false);
                    setSearch("");
                  }}
                  className="flex items-center gap-3"
                >
                  {token.logoURI ? (
                    <img src={token.logoURI} alt={token.symbol} className="w-8 h-8 rounded-full border border-border/50" />
                  ) : (
                    <div className="w-8 h-8 rounded-full bg-muted flex items-center justify-center text-xs font-semibold">
                      {token.symbol.slice(0, 2)}
                    </div>
                  )}
                  <div className="flex-1">
                    <div className="flex items-center gap-2">
                      <span className="font-medium">{token.symbol}</span>
                      <span className="text-[11px] text-muted-foreground">{token.name}</span>
                    </div>
                    <div className="text-[10px] text-muted-foreground/80 truncate">{token.address}</div>
                  </div>
                  <Check className={cn("h-4 w-4", value?.address === token.address ? "opacity-100" : "opacity-0")} />
                </CommandItem>
              ))}
            </CommandGroup>
          </Command>
        </PopoverContent>
      </Popover>
    </div>
  );
}
